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

// ---------- adapters ----------
export const adapters = {
  // Workday career sites: POST /wday/cxs/{tenant}/{site}/jobs
  async workday(src) {
    const out = [];
    for (const searchText of src.searches || ['']) {
      for (let offset = 0; offset < 1000; offset += 20) {
        const j = await getJSON(`https://${src.host}/wday/cxs/${src.tenant}/${src.site}/jobs`, { method: 'POST', body: { appliedFacets: {}, limit: 20, offset, searchText } });
        for (const p of j.jobPostings || []) {
          out.push({ title: p.title, url: `https://${src.host}/en-US/${src.site}${p.externalPath}`, ...splitLocation(p.locationsText), postedAt: null, description: '' });
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

  // SAP SuccessFactors Career Site Builder: /services/rss/job/?keywords=  (20 newest per keyword)
  async 'successfactors-rss'(src) {
    const out = [];
    const keywords = src.searches || ['human resources', 'HR', 'recruiter', 'talent', 'training', 'learning', 'benefits', 'compensation', 'HR intern'];
    for (const kw of keywords) {
      const xml = await getText(`${src.base.replace(/\/$/, '')}/services/rss/job/?locale=en_US&keywords=${encodeURIComponent(kw)}`);
      for (const item of rssItems(xml)) {
        const raw = tag(item, 'title');
        const m = raw.match(/^(.*)\(([^()]*)\)\s*$/);
        const title = (m ? m[1] : raw).trim();
        out.push({ title, url: tag(item, 'link').replace(/\?feedId=.*$/, ''), ...splitLocation(m ? m[2] : ''), postedAt: isoDate(tag(item, 'pubDate')), description: tag(item, 'description') });
      }
      await sleep(600);
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
