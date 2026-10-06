require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// ── Client ────────────────────────────────────────────────────────────────────
// Uses the service role key so server-side code bypasses RLS.
// Never expose this key to the browser.

let _db = null;

function db() {
  if (!_db) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
    }
    _db = createClient(url, key, {
      auth: { persistSession: false },
    });
  }
  return _db;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function assert(data, error, context) {
  if (error) {
    throw new Error(`[db/${context}] ${error.message}`);
  }
  return data;
}

// ── Users ─────────────────────────────────────────────────────────────────────

/**
 * Upsert a user row. Call this when a Stripe checkout completes.
 *
 * @param {object} opts
 * @param {string} opts.email
 * @param {string} opts.stripeCustomerId
 * @param {string} opts.stripeSubscriptionId
 * @param {string} opts.plan                  'pro' | 'agency'
 * @param {string} [opts.id]                  Supabase auth uid if available
 * @returns {Promise<object>} user row
 */
async function upsertUser({ id, email, stripeCustomerId, stripeSubscriptionId, plan }) {
  const row = {
    email,
    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: stripeSubscriptionId,
    plan,
    subscription_status: 'active',
  };
  if (id) row.id = id;

  const { data, error } = await db()
    .from('users')
    .upsert(row, { onConflict: 'stripe_customer_id' })
    .select()
    .single();

  return assert(data, error, 'upsertUser');
}

/**
 * Mark a user's subscription as cancelled.
 *
 * @param {string} stripeCustomerId
 * @returns {Promise<object>} updated user row
 */
async function cancelUser(stripeCustomerId) {
  const { data, error } = await db()
    .from('users')
    .update({ subscription_status: 'cancelled', plan: null })
    .eq('stripe_customer_id', stripeCustomerId)
    .select()
    .single();

  return assert(data, error, 'cancelUser');
}

/**
 * Mark a user's subscription as past_due after a failed payment.
 *
 * @param {string} stripeCustomerId
 */
async function markPaymentFailed(stripeCustomerId) {
  const { data, error } = await db()
    .from('users')
    .update({ subscription_status: 'past_due' })
    .eq('stripe_customer_id', stripeCustomerId)
    .select()
    .single();

  return assert(data, error, 'markPaymentFailed');
}

/**
 * Get a user by their Stripe customer id.
 *
 * @param {string} stripeCustomerId
 * @returns {Promise<object|null>}
 */
async function getUserByCustomerId(stripeCustomerId) {
  const { data, error } = await db()
    .from('users')
    .select('*')
    .eq('stripe_customer_id', stripeCustomerId)
    .maybeSingle();

  if (error) throw new Error(`[db/getUserByCustomerId] ${error.message}`);
  return data;
}

/**
 * Get a user by email.
 *
 * @param {string} email
 * @returns {Promise<object|null>}
 */
async function getUserByEmail(email) {
  const { data, error } = await db()
    .from('users')
    .select('*')
    .eq('email', email)
    .maybeSingle();

  if (error) throw new Error(`[db/getUserByEmail] ${error.message}`);
  return data;
}

// ── Sites ─────────────────────────────────────────────────────────────────────

/**
 * Create a new site for a user.
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.url
 * @param {string} opts.name
 * @param {string} [opts.schedule]
 * @param {number} [opts.maxPages]
 * @param {boolean} [opts.checkExternal]
 * @returns {Promise<object>} site row
 */
async function createSite({ userId, url, name, schedule, maxPages, checkExternal }) {
  const { data, error } = await db()
    .from('sites')
    .insert({
      user_id: userId,
      url,
      name,
      schedule: schedule || '0 8 * * 1',
      max_pages: maxPages ?? 100,
      check_external: checkExternal ?? true,
      active: true,
    })
    .select()
    .single();

  return assert(data, error, 'createSite');
}

/**
 * Get all active sites for a user.
 *
 * @param {string} userId
 * @returns {Promise<object[]>}
 */
async function getSitesByUser(userId) {
  const { data, error } = await db()
    .from('sites')
    .select('*')
    .eq('user_id', userId)
    .eq('active', true)
    .order('created_at', { ascending: true });

  return assert(data, error, 'getSitesByUser');
}

/**
 * Get all active sites across all users (used by the scheduler on startup).
 *
 * @returns {Promise<object[]>}
 */
async function getAllActiveSites() {
  const { data, error } = await db()
    .from('sites')
    .select('*, users(email)')
    .eq('active', true);

  return assert(data, error, 'getAllActiveSites');
}

/**
 * Get a single site by id.
 *
 * @param {string} siteId
 * @returns {Promise<object|null>}
 */
async function getSiteById(siteId) {
  const { data, error } = await db()
    .from('sites')
    .select('*, users(email)')
    .eq('id', siteId)
    .maybeSingle();

  if (error) throw new Error(`[db/getSiteById] ${error.message}`);
  return data;
}

/**
 * Soft-delete a site (sets active = false).
 *
 * @param {string} siteId
 * @param {string} userId  Ensures users can only delete their own sites.
 */
async function deleteSite(siteId, userId) {
  const { error } = await db()
    .from('sites')
    .update({ active: false })
    .eq('id', siteId)
    .eq('user_id', userId);

  if (error) throw new Error(`[db/deleteSite] ${error.message}`);
}

// ── Scans ─────────────────────────────────────────────────────────────────────

/**
 * Save the results of a completed crawl.
 *
 * @param {string} siteId
 * @param {object} results  Return value of crawl()
 * @returns {Promise<object>} scan row
 */
async function saveScan(siteId, results) {
  const { data, error } = await db()
    .from('scans')
    .insert({
      site_id: siteId,
      started_at: results.startedAt,
      finished_at: results.finishedAt,
      pages_crawled: results.pagesCrawled,
      external_checked: results.externalChecked,
      broken_count: results.broken.length,
      broken_links: results.broken,
    })
    .select()
    .single();

  return assert(data, error, 'saveScan');
}

/**
 * Get the scan history for a site, newest first.
 *
 * @param {string} siteId
 * @param {number} [limit=10]
 * @returns {Promise<object[]>}
 */
async function getScanHistory(siteId, limit = 10) {
  const { data, error } = await db()
    .from('scans')
    .select('*')
    .eq('site_id', siteId)
    .order('created_at', { ascending: false })
    .limit(limit);

  return assert(data, error, 'getScanHistory');
}

/**
 * Get the most recent scan for a site.
 *
 * @param {string} siteId
 * @returns {Promise<object|null>}
 */
async function getLatestScan(siteId) {
  const { data, error } = await db()
    .from('scans')
    .select('*')
    .eq('site_id', siteId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`[db/getLatestScan] ${error.message}`);
  return data;
}

module.exports = {
  // users
  upsertUser,
  cancelUser,
  markPaymentFailed,
  getUserByCustomerId,
  getUserByEmail,
  // sites
  createSite,
  getSitesByUser,
  getAllActiveSites,
  getSiteById,
  deleteSite,
  // scans
  saveScan,
  getScanHistory,
  getLatestScan,
};
