# LHRD Opportunity Crawler + Omni CMS component

This adds live job discovery to the LHRD Opportunity Engine. It has two parts.

| Part | What it does | Where it runs |
|---|---|---|
| `crawler/` | Reads employer job boards once a day. Keeps HR/HRD titles located in the six corridor metros. Merges them with the hand-verified records and writes `docs/feed.json`. | GitHub Actions (free, scheduled) |
| `omni-component/lhrd-opportunity-component.html` | The search page students use. Loads `feed.json` and provides search, metro, type, focus, function, level, and "verified vs. auto-discovered" filters. | Pasted into an Omni CMS component |

The crawler can't run inside Omni. Browsers block a page on lsu.edu from reading other sites' job boards (CORS), so the crawling runs on a schedule elsewhere and Omni only reads the finished `feed.json`.

## How listings are labeled

- **Verified by LHRD**: the curated records in `crawler/curated/` (from v0.9). If the crawler also finds the posting live, the card adds "still listed <date>".
- **Auto-discovered**: found by the crawler and not reviewed by a person. These cards have a gold top border, plus a note telling students to confirm details on the employer site.
- Auto-discovered listings drop off once a board stops listing them, after `graceDays` (3) so a brief outage doesn't remove them. If a board fails to load entirely, its earlier finds are kept.
- Expired deadlines are hidden both at crawl time and in the browser.
- **Every run re-opens each verified posting** and removes it when the employer's page clearly says it's closed: HTTP 404/410, a "no longer available / filled / expired" message, a redirect to an error page, or Workday's API reporting the job gone. Some pages can only be read in a real browser (ADP, Dayforce, UKG). Verified listings on those boards are hidden once their `verifiedAt` date is more than `curatedMaxAgeDays` (45) old, until someone re-checks them and updates the date in `crawler/curated/`.
- Each run lists what it removed, and why, under `removed` in `feed.json`.

## One-time setup (about 15 minutes)

1. **Create a GitHub repository**, such as `LHRD-Opportunity-Crawler` (public, or private on a plan that includes Pages). Upload this whole folder, including the hidden `.github` folder.
2. **Turn on Pages**: Settings → Pages → Source "Deploy from a branch" → branch `main`, folder `/docs`. The feed URL will be
   `https://<github-username>.github.io/LHRD-Opportunity-Crawler/feed.json`
3. **Allow the workflow to commit**: Settings → Actions → General → Workflow permissions → "Read and write permissions".
4. **Run it once**: Actions → "Crawl job boards" → Run workflow. After that it runs every day at 6 AM Central.
5. **Omni CMS**: open `omni-component/lhrd-opportunity-component.html` and replace the `data-feed="…"` URL on line 3 with your feed URL. In Omni, create a component (or open the page's source editor), paste the entire file in, and publish.
   - The component includes a `<script>`. If Omni's editor strips it, ask your Omni administrator to allow scripts for this component or to add it as a source/snippet component.
   - Hosting elsewhere: `feed.json` can live on any server that sends `Access-Control-Allow-Origin` (GitHub Pages does), or it can be uploaded into Omni itself (same site, no CORS needed).

## Adding or removing employers

Edit `crawler/sources.json`. Copy an existing entry that uses the same platform:

| adapter | Recognize it by job links like | Required fields |
|---|---|---|
| `workday` | `*.myworkdayjobs.com/...` | `host`, `tenant`, `site` (searched with HR keywords unless `searches` is set) |
| `successfactors` | `jobs.company.com/job/City-Title-ST-zip/123456/` | `base` (whole board is read unless `searches` is set) |
| `smartrecruiters` | `jobs.smartrecruiters.com/Company/...` | `company` |
| `neogov` | `governmentjobs.com/careers/<agency>` | `agency` |
| `ultipro` | `recruiting*.ultipro.com/<TENANT>/JobBoard/<guid>` | `host`, `tenant`, `board` |
| `rippling` | `ats.rippling.com/<board>/jobs` | `board` |
| `greenhouse` | `boards.greenhouse.io/<board>` | `board` |
| `lever` | `jobs.lever.co/<company>` | `company` |

Some v0.9 employers use platforms without a public feed: iCIMS, Taleo, ADP, Dayforce, Phenom career sites, and EasyApply. They stay in the curated list and aren't crawled.

To change what counts as an HR role, or how roles are labeled (internship/entry level, level, HR function, HRD/HRM focus), edit the patterns in `crawler/rules.json`.

## Running it locally

Requires Node.js 20 or later. No packages to install.

```
node crawler/crawl.mjs                     # all sources → docs/feed.json
node crawler/crawl.mjs --only "Entergy"    # test a single source
```

Each run prints one line per source (fetched / HR titles / in corridor). The same report is saved in `feed.json` under `sources`.

## Limits

- Classification is keyword-based on job titles. It labels a role's type, level, and track automatically, but doesn't read eligibility requirements, which is why auto-discovered cards say they're unreviewed.
- Some SuccessFactors boards (CMA CGM / CEVA) load their search results by script, so they can't be read and are paused in `sources.json`.
- To find a town the crawler skipped, add it to that metro's list in `crawler/curated/config.json`.
- Each source uses its employer's own public job feed or API at a polite pace, with an identifying User-Agent. If an employer changes platforms, that source's line in the run report will show `FAIL`.
