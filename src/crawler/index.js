const axios = require('axios');
const cheerio = require('cheerio');

const USER_AGENT = 'SnitchRootBot/1.0 (+https://snitchroot.com)';
const TIMEOUT_MS = 8000;
const CONCURRENCY = 5;

// Strip fragments and trailing slashes so "/" and "" and "/#top" count as one page.
function normalize(url) {
  const u = new URL(url);
  u.hash = '';
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.slice(0, -1);
  }
  return u.href;
}

async function fetchUrl(url, { wantBody }) {
  const opts = {
    timeout: TIMEOUT_MS,
    headers: { 'User-Agent': USER_AGENT },
    validateStatus: () => true,
    maxRedirects: 5,
  };

  try {
    if (!wantBody) {
      // Cheap HEAD first; some servers reject HEAD, so fall back to GET.
      let res = await axios.head(url, opts);
      if (res.status === 405 || res.status === 501 || res.status === 403) {
        res = await axios.get(url, { ...opts, responseType: 'stream' });
        res.data.destroy();
      }
      return { status: res.status };
    }
    const res = await axios.get(url, { ...opts, responseType: 'text' });
    return { status: res.status, body: res.data, type: res.headers['content-type'] || '' };
  } catch (error) {
    return { status: 'UNREACHABLE', error: error.code || error.message };
  }
}

/**
 * Crawl a site and report broken links.
 *
 * @param {string} startUrl
 * @param {number} maxPages  max same-domain pages to crawl
 * @param {object} [opts]
 * @param {boolean} [opts.checkExternal=true]  also check links that point off-site
 * @param {boolean} [opts.quiet=false]         suppress console output
 * @returns {Promise<{
 *   startUrl: string, startedAt: string, finishedAt: string,
 *   checked: number, pagesCrawled: number, externalChecked: number,
 *   broken: Array<{url: string, status: number|string, foundOn: string[], external: boolean}>
 * }>}
 */
async function crawl(startUrl, maxPages = 50, opts = {}) {
  const { checkExternal = true, quiet = false } = opts;
  const log = quiet ? () => {} : (...a) => console.log(...a);

  const start = normalize(startUrl);
  const origin = new URL(start).origin;
  const startedAt = new Date().toISOString();

  // All state is local to this call, so crawls can run back to back or in parallel.
  const queue = [start];
  const seenPages = new Set([start]);
  const linkSources = new Map(); // url -> Set of pages it was found on
  const externalUrls = new Set();
  const broken = [];
  let pagesCrawled = 0;

  log(`🕵️ SnitchRoot starting crawl on ${start}`);

  function recordLink(href, fromPage, baseUrl = fromPage) {
    let full;
    try {
      const parsed = new URL(href, baseUrl);
      if (!/^https?:$/.test(parsed.protocol)) return; // skip mailto:, tel:, javascript:
      full = normalize(parsed.href);
    } catch (_) {
      return; // malformed URL
    }

    if (!linkSources.has(full)) linkSources.set(full, new Set());
    linkSources.get(full).add(fromPage);

    if (full.startsWith(origin)) {
      if (!seenPages.has(full)) {
        seenPages.add(full);
        queue.push(full);
      }
    } else {
      externalUrls.add(full);
    }
  }

  async function processPage(url) {
    const res = await fetchUrl(url, { wantBody: true });
    pagesCrawled++;

    if (res.status === 'UNREACHABLE' || res.status >= 400) {
      broken.push({
        url,
        status: res.status,
        foundOn: [...(linkSources.get(url) || [])],
        external: false,
      });
      log(`🚨 BROKEN: ${url} — ${res.status}`);
      return;
    }

    if (!res.type.includes('html')) return; // don't parse PDFs, images, etc.

    const $ = cheerio.load(res.body);
    const base = $('base[href]').attr('href');
    const pageBase = base ? new URL(base, url).href : url;

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (href) recordLink(href, url, pageBase);
    });
  }

  // Crawl same-domain pages in small batches.
  while (queue.length > 0 && pagesCrawled < maxPages) {
    const batch = queue.splice(0, Math.min(CONCURRENCY, maxPages - pagesCrawled));
    log(`Checking: ${batch.join(', ')}`);
    await Promise.all(batch.map(processPage));
  }

  // Check every external link once.
  let externalChecked = 0;
  if (checkExternal) {
    const externals = [...externalUrls];
    for (let i = 0; i < externals.length; i += CONCURRENCY) {
      const batch = externals.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async (url) => {
          const res = await fetchUrl(url, { wantBody: false });
          externalChecked++;
          if (res.status === 'UNREACHABLE' || res.status >= 400) {
            broken.push({
              url,
              status: res.status,
              foundOn: [...(linkSources.get(url) || [])],
              external: true,
            });
            log(`🚨 BROKEN (external): ${url} — ${res.status}`);
          }
        })
      );
    }
  }

  const checked = pagesCrawled + externalChecked;
  log(`✅ Done. Checked ${checked} URLs. Found ${broken.length} broken links.`);

  return {
    startUrl: start,
    startedAt,
    finishedAt: new Date().toISOString(),
    checked,
    pagesCrawled,
    externalChecked,
    broken,
  };
}

module.exports = { crawl };
