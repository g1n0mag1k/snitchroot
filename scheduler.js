require('dotenv').config();
const cron = require('node-cron');
const { crawl } = require('../crawler');
const { sendReport } = require('../mailer');

const jobs = new Map();

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

    try {
      const db = require('../db');
      await db.saveScan(site.id, results);
      console.log(`💾 Scan saved to DB for ${site.name}`);
    } catch (dbErr) {
      console.warn(`⚠️  Could not save scan to DB: ${dbErr.message}`);
    }

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

function registerSite(site) {
  const schedule = site.schedule || '0 8 * * 1';

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

function unregisterSite(id) {
  const job = jobs.get(id);
  if (!job) return false;
  job.task.stop();
  jobs.delete(id);
  console.log(`🗑  Unregistered site ${id}`);
  return true;
}

async function scanNow(id) {
  const job = jobs.get(id);
  if (!job) throw new Error(`No registered site with id "${id}"`);
  await runSiteScan(job.site);
}

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

async function loadSitesFromDB() {
  try {
    const db = require('../db');
    const sites = await db.getAllActiveSites();

    if (sites.length === 0) {
      console.log('📭 No active sites in DB to schedule');
      return;
    }

    for (const site of sites) {
      registerSite({
        id: site.id,
        url: site.url,
        name: site.name,
        ownerEmail: site.users?.email || '',
        schedule: site.schedule,
        maxPages: site.max_pages,
        checkExternal: site.check_external,
      });
    }

    console.log(`📅 Loaded ${sites.length} site(s) from DB into scheduler`);
  } catch (err) {
    console.error('❌ Failed to load sites from DB:', err.message);
  }
}

module.exports = { registerSite, unregisterSite, scanNow, listJobs, loadSitesFromDB };
