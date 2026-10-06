require('dotenv').config();
const cron = require('node-cron');
const { crawl } = require('../crawler');
const { sendReport } = require('../mailer');

/**
 * In-memory job registry. In production this should come from your Supabase `sites` table.
 * Shape of each site entry:
 * {
 *   id: string,
 *   url: string,
 *   name: string,
 *   ownerEmail: string,
 *   schedule: string,          // cron expression, e.g. '0 8 * * 1' = Mondays at 8 AM
 *   maxPages: number,
 *   checkExternal: boolean,
 *   lastRunAt: Date|null,
 *   running: boolean,
 * }
 */
const jobs = new Map();     // id -> { site, task }

/**
 * Run a crawl for one site and email the report to its owner.
 */
async function runSiteScan(site) {
  if (site.running) {
    console.log(`⏭  Skipping ${site.name} — previous scan still in progress`);
    return;
  }

  site.running = true;
  site.lastRunAt = new Date();
  console.log(`🔍 Starting scheduled scan: ${site.name} (${site.url})`);

  try {
    const results = await crawl(site.url, site.maxPages ?? 100, {
      checkExternal: site.checkExternal ?? true,
      quiet: false,
    });

    await sendReport({
      to: site.ownerEmail,
      siteName: site.name,
      siteUrl: site.url,
      results,
    });

    console.log(`📤 Report sent for ${site.name} — ${results.broken.length} broken link(s)`);
  } catch (err) {
    console.error(`❌ Scan failed for ${site.name}:`, err.message);
  } finally {
    site.running = false;
  }
}

/**
 * Register a site for automatic scanning.
 *
 * @param {object} site
 * @param {string} site.id
 * @param {string} site.url
 * @param {string} site.name
 * @param {string} site.ownerEmail
 * @param {string} [site.schedule]        Cron expression (default: weekly Monday 8 AM)
 * @param {number} [site.maxPages]
 * @param {boolean} [site.checkExternal]
 * @returns {{ id: string, schedule: string }} registered job info
 */
function registerSite(site) {
  const schedule = site.schedule || '0 8 * * 1'; // every Monday at 08:00

  if (!cron.validate(schedule)) {
    throw new Error(`Invalid cron expression for site ${site.id}: "${schedule}"`);
  }

  if (jobs.has(site.id)) {
    unregisterSite(site.id);
  }

  const entry = { ...site, running: false, lastRunAt: null, schedule };
  const task = cron.schedule(schedule, () => runSiteScan(entry), {
    scheduled: true,
    timezone: process.env.TZ || 'UTC',
  });

  jobs.set(site.id, { site: entry, task });
  console.log(`📅 Registered ${site.name} → "${schedule}" (${site.url})`);
  return { id: site.id, schedule };
}

/**
 * Remove a site from the scheduler.
 */
function unregisterSite(id) {
  const job = jobs.get(id);
  if (!job) return false;
  job.task.stop();
  jobs.delete(id);
  console.log(`🗑  Unregistered site ${id}`);
  return true;
}

/**
 * Trigger an immediate on-demand scan (bypasses cron, still guards against overlap).
 */
async function scanNow(id) {
  const job = jobs.get(id);
  if (!job) throw new Error(`No registered site with id "${id}"`);
  await runSiteScan(job.site);
}

/**
 * List all registered jobs and their status.
 */
function listJobs() {
  return [...jobs.entries()].map(([id, { site }]) => ({
    id,
    name: site.name,
    url: site.url,
    schedule: site.schedule,
    ownerEmail: site.ownerEmail,
    running: site.running,
    lastRunAt: site.lastRunAt,
  }));
}

module.exports = { registerSite, unregisterSite, scanNow, listJobs };
