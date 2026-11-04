#!/usr/bin/env node
// LHRD Opportunity Crawler: reads employer job boards, keeps HR/HRD roles in the
// six-metro corridor, merges them with the hand-verified records, and writes docs/feed.json.
// Usage: node crawler/crawl.mjs [--only "Employer name"] [--out docs/feed.json]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapters, stripHTML } from './adapters.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const outPath = resolve(here, '..', flag('--out') || 'docs/feed.json');
const only = flag('--only');
const today = new Date().toISOString().slice(0, 10);

const readJSON = async (p, fallback) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch (e) { if (fallback !== undefined) return fallback; throw e; } };
const rules = await readJSON(resolve(here, 'rules.json'));
const { sources } = await readJSON(resolve(here, 'sources.json'));
const config = await readJSON(resolve(here, 'curated/config.json'));
const curatedUG = await readJSON(resolve(here, 'curated/opportunities.json'));
const curatedGR = await readJSON(resolve(here, 'curated/masters.json'));
const previous = await readJSON(outPath, { items: [] });

const rx = s => new RegExp(s, 'i');
const R = {
  strong: rx(rules.hr.strong), weak: rx(rules.hr.weak), excludeWeak: rx(rules.hr.excludeWhenWeak), excludeAlways: rx(rules.hr.excludeAlways),
  type: Object.entries(rules.type).map(([k, v]) => [k, rx(v)]),
  level: Object.entries(rules.level).map(([k, v]) => [k, rx(v)]),
  family: Object.entries(rules.family).map(([k, v]) => [k, rx(v)]),
};

// ---------- geography: map a posting's city/state to one of the six corridor metros ----------
const metroState = { Houston: 'TX', Beaumont: 'TX', 'Lake Charles': 'LA', Lafayette: 'LA', 'Baton Rouge': 'LA', 'New Orleans': 'LA' };
const norm = s => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\bst\.?\s/g, 'st ').replace(/[^a-z0-9]+/g, ' ').trim();
const localityIndex = Object.entries(config.metros).flatMap(([metro, towns]) => towns.map(town => ({ metro, town, key: norm(town), state: metroState[metro] })))
  .sort((a, b) => b.key.length - a.key.length);
function stateOf(text) {
  if (/\b(tx|texas)\b/i.test(text)) return 'TX';
  if (/\b(la|louisiana)\b/i.test(text)) return 'LA';
  return '';
}
function placeInCorridor(p) {
  const state = stateOf(`${p.state} ${p.locationText}`);
  const city = ` ${norm(p.city || p.locationText)} `;
  for (const l of localityIndex) {
    if (!city.includes(` ${l.key} `)) continue;
    if (state ? state === l.state : (l.town === l.metro && l.town !== 'Lafayette')) return { metro: l.metro, locality: l.town, state: l.state };
  }
  return null;
}

// ---------- classification ----------
function isHR(title) {
  if (R.excludeAlways.test(title)) return false;
  if (R.strong.test(title)) return true;
  return R.weak.test(title) && !R.excludeWeak.test(title);
}
const first = (pairs, text, fallback) => (pairs.find(([, re]) => re.test(text)) || [fallback])[0];
function classify(title) {
  const type = first(R.type, title, 'Experienced');
  const level = type === 'Internship' ? 'Internship' : type === 'Entry level' && !R.level.some(([, re]) => re.test(title)) ? 'Entry level' : first(R.level, title, 'Professional');
  const family = first(R.family, title, 'relations');
  const focus = /\b(generalist|business partner|hrbp|human resources (manager|director|intern))\b/i.test(title) ? 'Blended' : rules.focusByFamily[family] || 'Blended';
  const graduateSignal = /\b(graduate|mba|master'?s)\b/i.test(title);
  const tracks = graduateSignal || ['Senior', 'Manager', 'Director', 'Professional'].includes(level) ? ['graduate'] : ['undergraduate'];
  return { type: level === 'Entry level' || type === 'Internship' ? type : 'Experienced', level, family, focus, tracks };
}
const workModeOf = p => p.workMode || (/\bremote\b/i.test(p.title + ' ' + p.description) ? 'Remote' : /\bhybrid\b/i.test(p.title + ' ' + p.description) ? 'Hybrid' : 'Not specified');
const urlKey = u => String(u || '').replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
const dupKey = (employer, title, locality) => norm(`${employer}|${title}|${locality}`);
const slug = s => norm(s).replace(/ /g, '-').slice(0, 60);
const summarize = d => { const t = stripHTML(d); return t.length > rules.summaryLength ? t.slice(0, rules.summaryLength).replace(/\s+\S*$/, '') + '…' : t; };

// ---------- crawl ----------
const report = [];
const crawled = new Map();
const prevById = new Map(previous.items.map(i => [i.id, i]));
const active = sources.filter(s => s.enabled !== false && (!only || s.employer === only));

for (const src of active) {
  const started = Date.now();
  const entry = { employer: src.employer, adapter: src.adapter, ok: false, fetched: 0, hr: 0, inCorridor: 0, error: null };
  try {
    const read = adapters[src.adapter];
    if (!read) throw new Error(`Unknown adapter "${src.adapter}"`);
    const raw = await read(src);
    entry.fetched = raw.length;
    for (const p of raw) {
      if (!p.title || !p.url || !isHR(p.title)) continue;
      entry.hr++;
      const place = placeInCorridor(p);
      if (!place) continue;
      if (p.deadlineISO && p.deadlineISO < today) continue;
      const c = classify(p.title);
      const id = `auto-${slug(src.employer)}-${slug(p.title)}-${slug(place.locality)}`;
      if (crawled.has(id)) continue;
      entry.inCorridor++;
      crawled.set(id, {
        id, origin: 'crawled', title: p.title.trim(), employer: src.employer,
        location: `${place.locality}, ${place.state}`, locality: place.locality, area: `${place.metro} area`,
        ...c, workMode: workModeOf(p), salary: p.salary || 'Not posted',
        deadlineISO: p.deadlineISO || null, deadline: p.deadlineISO || 'Not posted',
        postedAt: p.postedAt || null, summary: summarize(p.description),
        url: p.url, source: `${src.employer} job board (${src.adapter})`, status: 'open',
        firstSeenAt: prevById.get(id)?.firstSeenAt || today, lastSeenAt: today, verifiedAt: null,
      });
    }
    entry.ok = true;
  } catch (err) {
    entry.error = String(err?.message || err);
  }
  entry.seconds = Math.round((Date.now() - started) / 100) / 10;
  report.push(entry);
  console.log(`${entry.ok ? 'ok  ' : 'FAIL'} ${src.employer.padEnd(34)} fetched=${entry.fetched} hr=${entry.hr} corridor=${entry.inCorridor}${entry.error ? '  ' + entry.error : ''}`);
}

// Keep earlier finds from boards that failed this run, or that disappeared less than graceDays ago.
const failed = new Set(report.filter(r => !r.ok).map(r => r.employer));
const graceCutoff = new Date(Date.now() - rules.graceDays * 864e5).toISOString().slice(0, 10);
for (const old of previous.items) {
  if (old.origin !== 'crawled' || crawled.has(old.id) || !isHR(old.title)) continue;
  if (only && old.employer !== only) { crawled.set(old.id, old); continue; }
  if ((failed.has(old.employer) || old.lastSeenAt >= graceCutoff) && (!old.deadlineISO || old.deadlineISO >= today)) crawled.set(old.id, old);
}

// ---------- merge with hand-verified records ----------
const curated = [
  ...curatedUG.map(o => ({ ...o, origin: 'curated', level: o.type, family: o.family || null, workMode: o.workMode || 'Not specified', summary: o.fit })),
  ...curatedGR.map(o => ({ ...o, origin: 'curated', type: 'Experienced', summary: o.fit, eligibility: o.requirements })),
].filter(o => o.status === 'open' && (!o.deadlineISO || o.deadlineISO >= today));

const crawledByUrl = new Map([...crawled.values()].map(c => [urlKey(c.url), c]));
const crawledByDup = new Map([...crawled.values()].map(c => [dupKey(c.employer, c.title, c.locality), c]));
for (const o of curated) {
  const match = crawledByUrl.get(urlKey(o.url)) || crawledByDup.get(dupKey(o.employer, o.title, o.locality));
  if (match) { o.lastSeenAt = match.lastSeenAt; crawled.delete(match.id); }
}

const items = [...curated, ...crawled.values()].sort((a, b) => (a.origin === b.origin ? 0 : a.origin === 'curated' ? -1 : 1) || String(b.postedAt || b.verifiedAt || '').localeCompare(String(a.postedAt || a.verifiedAt || '')));
const feed = {
  generatedAt: new Date().toISOString(),
  schemaVersion: 1,
  cities: config.cities,
  aliases: config.aliases,
  masterFamilies: config.masterFamilies,
  counts: { total: items.length, curated: curated.length, crawled: crawled.size, undergraduate: items.filter(i => i.tracks.includes('undergraduate')).length, graduate: items.filter(i => i.tracks.includes('graduate')).length },
  sources: report,
  items,
};
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify(feed, null, 1) + '\n');
console.log(`\nWrote ${outPath}: ${feed.counts.total} items (${feed.counts.curated} verified, ${feed.counts.crawled} auto-discovered). ${failed.size} source(s) failed.`);
if (report.length && report.every(r => !r.ok)) process.exitCode = 1;
