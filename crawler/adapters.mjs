// One reader per job-board platform. Each returns raw postings:
// { title, url, city, state, locationText, postedAt, deadlineISO, salary, description, workMode }
// Every adapter reads a public, documented-for-embedding feed or API the employer publishes itself.

const UA = 'LSU-LHRD-OpportunityCrawler/1.0 (+https://www.lsu.edu/chse/slhrd/)';
const TIMEOUT_MS = 25000;

async function request(url, { method = 'GET', body, headers = {}, retries = 1 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: { 'User-Agent': UA, Accept: 'application/json, application/rss+xml, text/xml, */*', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        signal: ctrl.signal,
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      return res;
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(2000);
    } finally {
      clearTimeout(timer);
    }
  }
}
const getJSON = (url, opts) => request(url, opts).then(r => r.json());
const getText = (url, opts) => request(url, opts).then(r => r.text());
export const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- small helpers ----------
const decodeEntities = s => String(s ?? '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
export const stripHTML = s => decodeEntities(decodeEntities(s)).replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/Â/g, '').replace(/\s+/g, ' ').trim();
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i')); return m ? decodeEntities(m[1]).trim() : ''; };
const rssItems = xml => xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
const isoDate = d => { const t = Date.parse(String(d).replace(/:0$/, '')); return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10); };
// "Baton Rouge, LA" | "Houston, TX, US, 77042" | "Spring, Texas, United States"
function splitLocation(text) {
  const parts = String(text || '').split(',').map(p => p.trim()).filter(Boolean);
  return { city: parts[0] || '', state: parts[1] || '', locationText: parts.slice(0, 2).join(', ') || String(text || '') };
}

// Keyword searches for boards too large to read whole; the title rules still decide what is kept.
const HR_SEARCHES = ['human resources', 'HR', 'recruiter', 'recruiting', 'talent', 'learning', 'training', 'benefits', 'compensation', 'people'];

// ---------- adapters ----------
export const adapters = {
  // Workday career sites: POST /wday/cxs/{tenant}/{site}/jobs
  async workday(src, ctx = {}) {
    const out = [];
    const api = `https://${src.host}/wday/cxs/${src.tenant}/${src.site}`;
    const seen = new Set();
    for (const searchText of src.searches || HR_SEARCHES) {
      for (let offset = 0; offset < 1000; offset += 20) {
        const j = await getJSON(`${api}/jobs`, { method: 'POST', body: { appliedFacets: {}, limit: 20, offset, searchText } });
        for (const p of j.jobPostings || []) {
          if (seen.has(p.externalPath)) continue;
          seen.add(p.externalPath);
          const url = `https://${src.host}/en-US/${src.site}${p.externalPath}`;
          // "3 Locations": read the posting itself for the full location list, only for titles we would keep
          if (/^\d+ Locations?$/i.test(p.locationsText || '') && ctx.isRelevant?.(p.title)) {
            try {
              const d = (await getJSON(`${api}${p.externalPath}`)).jobPostingInfo || {};
              for (const loc of [d.location, ...(d.additionalLocations || [])].filter(Boolean)) out.push({ title: p.title, url, ...splitLocation(loc), postedAt: isoDate(d.startDate), description: d.jobDescription || '' });
              await sleep(300);
              continue;
            } catch { /* fall through with the summary row */ }
          }
          out.push({ title: p.title, url, ...splitLocation(p.locationsText), postedAt: null, description: '' });
        }
        if (!j.jobPostings?.length || offset + 20 >= (j.total || 0)) break;
        await sleep(400);
      }
    }
    return out;
  },

  // SmartRecruiters public posting API
  async smartrecruiters(src) {
    const out = [];
    for (const q of src.searches || ['']) {
      for (let offset = 0; offset < 500; offset += 100) {
        const j = await getJSON(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(src.company)}/postings?country=us&limit=100&offset=${offset}&q=${encodeURIComponent(q)}`);
        for (const p of j.content || []) {
          out.push({
            title: p.name, url: `https://jobs.smartrecruiters.com/${src.company}/${p.id}`,
            city: p.location?.city || '', state: p.location?.region || '', locationText: [p.location?.city, p.location?.region].filter(Boolean).join(', '),
            postedAt: isoDate(p.releasedDate), workMode: p.location?.remote ? 'Remote' : p.location?.hybrid ? 'Hybrid' : '', description: '',
          });
        }
        if (offset + 100 >= (j.totalFound || 0)) break;
        await sleep(400);
      }
    }
    return out;
  },

  // SAP SuccessFactors Career Site Builder: pages through /search/ results (table or tile layout).
  // With no `searches` it reads the whole board; the title rules then keep the HR roles.
  async successfactors(src) {
    const base = src.base.replace(/\/$/, '');
    const origin = new URL(base).origin;
    const out = [], seen = new Set();
    const field = (seg, name) => stripHTML((seg.match(new RegExp(`section-${name}-value"[^>]*>([\\s\\S]*?)<`)) || [])[1] || '');
    for (const q of src.searches || ['']) {
      for (let start = 0; start < (src.maxRows || 2500);) {
        const html = await getText(`${base}/search/?q=${encodeURIComponent(q)}&startrow=${start}`);
        const anchors = [...html.matchAll(/<a\b[^>]*class="jobTitle-link[^"]*"[^>]*>[\s\S]*?<\/a>/g)];
        let fresh = 0;
        anchors.forEach((a, i) => {
          const href = (a[0].match(/href="([^"]+)"/) || [])[1];
          if (!href) return;
          const url = new URL(decodeEntities(href), origin).href;
          if (seen.has(url)) return;
          seen.add(url); fresh++;
          // fields for this job sit between its link and the next job's link
          const seg = html.slice(a.index, anchors.slice(i + 1).find(b => !b[0].includes(href))?.index ?? a.index + 6000);
          const tableLoc = stripHTML((seg.match(/<span class="jobLocation">([\s\S]*?)<\/span>/) || [])[1] || '');
          const tileLoc = [field(seg, 'city'), field(seg, 'state')].filter(Boolean).join(', ') || field(seg, 'location');
          const date = stripHTML((seg.match(/<span class="jobDate[^"]*">([\s\S]*?)<\/span>/) || [])[1] || '') || field(seg, 'date');
          out.push({ title: stripHTML(a[0]), url, ...splitLocation(tableLoc || tileLoc), postedAt: isoDate(date), description: '' });
        });
        if (!fresh) break;
        start += fresh;
        await sleep(500);
      }
    }
    return out;
  },

  // NEOGOV / governmentjobs.com agency RSS feed (whole agency in one feed)
  async neogov(src) {
    const xml = await getText(`https://www.governmentjobs.com/SearchEngine/JobsFeed?agency=${encodeURIComponent(src.agency)}`);
    return rssItems(xml).map(item => {
      const min = tag(item, 'joblisting:minimumSalary'), max = tag(item, 'joblisting:maximumSalary'), per = tag(item, 'joblisting:salaryInterval');
      return {
        title: tag(item, 'title'), url: tag(item, 'link'),
        city: tag(item, 'joblisting:location'), state: tag(item, 'joblisting:state') || src.state || (src.agency === 'houston' ? 'TX' : 'LA'),
        locationText: tag(item, 'joblisting:location'),
        postedAt: isoDate(tag(item, 'joblisting:advertiseFromDate')), deadlineISO: isoDate(tag(item, 'joblisting:advertiseToDateTime')),
        salary: min && max ? `$${(+min).toLocaleString()}–$${(+max).toLocaleString()} per ${per.toLowerCase() || 'period'}` : '',
        description: tag(item, 'description'),
      };
    });
  },

  // UKG / UltiPro Recruiting job boards
  async ultipro(src) {
    const out = [];
    for (const q of src.searches || ['']) {
      const j = await getJSON(`https://${src.host}/${src.tenant}/JobBoard/${src.board}/JobBoardView/LoadSearchResults`, { method: 'POST', body: { opportunitySearch: { Top: 100, Skip: 0, QueryString: q, OrderBy: [], Filters: [] } } });
      for (const p of j.opportunities || []) {
        const a = p.Locations?.[0]?.Address || {};
        out.push({
          title: p.Title, url: `https://${src.host}/${src.tenant}/JobBoard/${src.board}/OpportunityDetail?opportunityId=${p.Id}`,
          city: a.City || '', state: a.State?.Code || '', locationText: [a.City, a.State?.Code].filter(Boolean).join(', '),
          postedAt: isoDate(p.PostedDate), description: p.BriefDescription || '',
        });
      }
      await sleep(400);
    }
    return out;
  },

  // Rippling ATS job boards
  async rippling(src) {
    const out = [];
    for (let page = 0; page < 20; page++) {
      const j = await getJSON(`https://ats.rippling.com/api/v2/board/${encodeURIComponent(src.board)}/jobs?page=${page}&pageSize=50`);
      for (const p of j.items || []) {
        const l = p.locations?.[0] || {};
        out.push({ title: p.name, url: p.url, city: l.city || '', state: l.stateCode || l.state || '', locationText: l.name || '', workMode: l.workplaceType === 'REMOTE' ? 'Remote' : l.workplaceType === 'HYBRID' ? 'Hybrid' : l.workplaceType === 'ON_SITE' ? 'On-site' : '', description: '' });
      }
      if (!j.items?.length || page + 1 >= (j.totalPages || 1)) break;
    }
    return out;
  },

  // Greenhouse job boards (boards-api.greenhouse.io)
  async greenhouse(src) {
    const j = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(src.board)}/jobs`);
    return (j.jobs || []).map(p => ({ title: p.title, url: p.absolute_url, ...splitLocation(p.location?.name), postedAt: isoDate(p.updated_at), description: '' }));
  },

  // Lever job boards (api.lever.co)
  async lever(src) {
    const j = await getJSON(`https://api.lever.co/v0/postings/${encodeURIComponent(src.company)}?mode=json`);
    return (j || []).map(p => ({ title: p.text, url: p.hostedUrl, ...splitLocation(p.categories?.location), workMode: p.workplaceType === 'remote' ? 'Remote' : p.workplaceType === 'hybrid' ? 'Hybrid' : '', postedAt: p.createdAt ? new Date(p.createdAt).toISOString().slice(0, 10) : null, description: p.descriptionPlain || '' }));
  },
};

// ---------- liveness: is a posting page still open? ----------
// Returns { state: 'open' | 'closed' | 'unknown', reason }. Only clear signals count as closed;
// pages that need a real browser to render (ADP, Dayforce, UKG) come back 'unknown' and are left alone.
const CLOSED_TEXT = /no longer (available|accepting applications|active|open|posted)|(position|job|requisition) has been (filled|closed|removed)|this (job|position|posting|requisition) (has )?(expired|closed|been filled)|posting has expired|job (is )?no longer available|job not found|this job has moved or is no longer available|not accepting applications/i;
const CLOSED_URL = /[?&/](error|invalidjob|job_not_found|notfound|not-found|expired)\b|rr_message=job_not_found/i;
const keyWords = title => String(title).toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter(w => w.length > 4).slice(0, 3);

export async function checkPosting(url, title) {
  try {
    const wd = String(url).match(/^https:\/\/([^/]+\.myworkdayjobs\.com)\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/]+)(\/job\/.+)$/);
    if (wd) {
      const tenant = wd[1].split('.')[0];
      const res = await fetch(`https://${wd[1]}/wday/cxs/${tenant}/${wd[2]}${wd[3]}`, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if ([403, 404, 410].includes(res.status)) return { state: 'closed', reason: `Workday HTTP ${res.status}` };
      return res.ok ? { state: 'open', reason: 'Workday API' } : { state: 'unknown', reason: `Workday HTTP ${res.status}` };
    }
    const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': `Mozilla/5.0 (compatible; ${UA})`, Accept: 'text/html,*/*' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if ([404, 410].includes(res.status)) return { state: 'closed', reason: `HTTP ${res.status}` };
    if (!res.ok) return { state: 'unknown', reason: `HTTP ${res.status}` };
    if (CLOSED_URL.test(res.url)) return { state: 'closed', reason: `redirected to ${res.url}` };
    const text = stripHTML((await res.text()).slice(0, 500000));
    const m = text.match(CLOSED_TEXT);
    if (m) return { state: 'closed', reason: `page says "${m[0]}"` };
    const words = keyWords(title), lower = text.toLowerCase();
    const titleShown = words.length > 0 && words.every(w => lower.includes(w));
    const redirected = new URL(res.url).pathname.replace(/\/$/, '') !== new URL(url).pathname.replace(/\/$/, '');
    if (redirected && !titleShown && text.length > 500) return { state: 'closed', reason: `redirected to a page without the job (${res.url})` };
    return titleShown ? { state: 'open', reason: 'title on page' } : { state: 'unknown', reason: 'page did not show the job' };
  } catch (err) {
    return { state: 'unknown', reason: String(err?.message || err) };
  }
}
