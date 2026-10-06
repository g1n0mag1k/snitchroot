const axios = require('axios');
const cheerio = require('cheerio');

const visited = new Set();
const broken = [];

async function checkLink(url) {
  try {
    const response = await axios.get(url, { timeout: 8000 });
    return { url, status: response.status, ok: true };
  } catch (error) {
    const status = error.response ? error.response.status : 'UNREACHABLE';
    return { url, status, ok: false };
  }
}

async function crawl(startUrl, maxPages = 50) {
  const queue = [startUrl];
  const results = { broken: [], checked: 0 };
  const base = new URL(startUrl).origin;

  console.log(`🕵️ SnitchRoot starting crawl on ${startUrl}`);

  while (queue.length > 0 && results.checked < maxPages) {
    const currentUrl = queue.shift();

    if (visited.has(currentUrl)) continue;
    visited.add(currentUrl);

    console.log(`Checking: ${currentUrl}`);

    const check = await checkLink(currentUrl);
    results.checked++;

    if (!check.ok) {
      results.broken.push(check);
      console.log(`🚨 BROKEN: ${currentUrl} — ${check.status}`);
      continue;
    }

    // Only crawl pages on the same domain
    try {
      const response = await axios.get(currentUrl, { timeout: 8000 });
      const $ = cheerio.load(response.data);

      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (!href) return;

        try {
          const fullUrl = new URL(href, base).href;
          if (fullUrl.startsWith(base) && !visited.has(fullUrl)) {
            queue.push(fullUrl);
          }
        } catch (_) {
          // skip malformed URLs
        }
      });
    } catch (_) {
      // skip pages we can't parse
    }
  }

  console.log(`✅ Done. Checked ${results.checked} pages. Found ${results.broken.length} broken links.`);
  return results;
}

module.exports = { crawl };