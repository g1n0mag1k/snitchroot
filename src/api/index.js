require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const { crawl } = require('../crawler');
const { sendReport } = require('../mailer');
const { registerSite, unregisterSite, scanNow, listJobs } = require('../scheduler');
const {
  PLANS,
  getOrCreateCustomer,
  createCheckoutSession,
  createPortalSession,
  constructWebhookEvent,
  handleWebhookEvent,
} = require('../billing');
const db = require('../db');

const router = express.Router();

// ── Rate limiting ─────────────────────────────────────────────────────────────

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,       // 1 minute
  max: 60,                   // 60 requests per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests, slow down.' },
});

const scanLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,                    // 5 scan requests per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Scan rate limit exceeded.' },
});

router.use(globalLimiter);

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok(res, data, status = 200) {
  return res.status(status).json({ ok: true, ...data });
}
function err(res, message, status = 400) {
  return res.status(status).json({ ok: false, error: message });
}

// ── Auth middleware ───────────────────────────────────────────────────────────
// Verifies the Supabase JWT from Authorization: Bearer <token>
// Puts the verified user on req.user — never trust req.body.userId

function getSupabaseAdmin() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
}

async function requireUser(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '').trim();
  if (!token) return err(res, 'Unauthorized', 401);

  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return err(res, 'Unauthorized', 401);

    // Attach the full DB user row (has plan, subscription_status, stripe_customer_id)
    const dbUser = await db.getUserByEmail(data.user.email);
    req.user = {
      id: data.user.id,
      email: data.user.email,
      plan: dbUser?.plan || null,
      subscription_status: dbUser?.subscription_status || null,
      stripe_customer_id: dbUser?.stripe_customer_id || null,
    };
    next();
  } catch (e) {
    console.error('requireUser error:', e.message);
    return err(res, 'Unauthorized', 401);
  }
}

// Internal-only middleware (scheduler/webhook calls, not user-facing)
function requireInternalKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (!key || key !== process.env.INTERNAL_API_KEY) return err(res, 'Unauthorized', 401);
  next();
}

// ── Health ────────────────────────────────────────────────────────────────────
router.get('/health', (_req, res) => ok(res, { status: 'ok', ts: new Date().toISOString() }));

// ── Plans ─────────────────────────────────────────────────────────────────────
router.get('/plans', (_req, res) => {
  const plans = Object.entries(PLANS).map(([slug, p]) => ({
    slug, name: p.name, amount: p.amount, currency: p.currency,
    interval: p.interval, maxSites: p.maxSites, maxPages: p.maxPages,
  }));
  ok(res, { plans });
});

// ── Billing ───────────────────────────────────────────────────────────────────

// Checkout is intentionally open — user may not be logged in yet when they hit pay.
// We pass their email + userId from the frontend after Supabase signup.
router.post('/billing/checkout', async (req, res) => {
  try {
    const { email, name, plan, userId } = req.body;
    if (!email || !plan) return err(res, 'email and plan are required');
    if (!PLANS[plan]) return err(res, `Invalid plan: ${plan}`);
    const customerId = await getOrCreateCustomer({ email, name });
    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    const { sessionId, url } = await createCheckoutSession({
      customerId, plan,
      successUrl: `${appUrl}/dashboard?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${appUrl}/?checkout=cancelled`,
      clientReferenceId: userId || null,
    });
    ok(res, { sessionId, url });
  } catch (e) {
    console.error('Checkout error:', e.message);
    err(res, e.message);
  }
});

router.post('/billing/portal', requireUser, async (req, res) => {
  try {
    if (!req.user.stripe_customer_id) return err(res, 'No billing account found');
    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    const url = await createPortalSession({
      customerId: req.user.stripe_customer_id,
      returnUrl: `${appUrl}/dashboard`,
    });
    ok(res, { url });
  } catch (e) {
    err(res, e.message);
  }
});

router.post('/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = constructWebhookEvent(req.body, sig);
  } catch (e) {
    console.error('Webhook signature verification failed:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  const action = handleWebhookEvent(event);
  console.log(`Stripe webhook: ${event.type} → action: ${action.type}`);

  try {
    if (action.type === 'subscription.activated') {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      const customer = await stripe.customers.retrieve(action.customerId);
      await db.upsertUser({
        email: customer.email,
        stripeCustomerId: action.customerId,
        stripeSubscriptionId: action.subscriptionId,
        plan: action.plan,
      });
      console.log(`✅ Activated user ${customer.email} on plan ${action.plan}`);
    }
    if (action.type === 'subscription.cancelled') {
      await db.cancelUser(action.customerId);
      console.log(`❌ Cancelled subscription for customer ${action.customerId}`);
    }
    if (action.type === 'payment.failed') {
      await db.markPaymentFailed(action.customerId);
      console.log(`⚠️  Payment failed for customer ${action.customerId}`);
    }
  } catch (e) {
    console.error('DB error processing webhook:', e.message);
    return res.status(500).json({ error: 'processing failed' });
  }

  res.json({ received: true });
});

// ── Sites ─────────────────────────────────────────────────────────────────────

router.post('/sites', requireUser, async (req, res) => {
  try {
    // Must have an active paid subscription
    if (req.user.subscription_status !== 'active') {
      return err(res, 'Active subscription required', 403);
    }

    const { url, name, schedule, checkExternal } = req.body;
    if (!url || !name) return err(res, 'url and name are required');
    try { new URL(url); } catch { return err(res, 'Invalid URL'); }

    // Enforce plan site limit server-side
    const plan = PLANS[req.user.plan];
    if (!plan) return err(res, 'Unknown plan', 403);

    const existingSites = await db.getSitesByUser(req.user.id);
    if (existingSites.length >= plan.maxSites) {
      return err(res, `Site limit reached for your plan (max ${plan.maxSites})`, 403);
    }

    // Cap maxPages at plan limit — never trust client value
    const maxPages = Math.min(
      parseInt(req.body.maxPages) || plan.maxPages,
      plan.maxPages
    );

    const site = await db.createSite({
      userId: req.user.id,
      url, name, schedule, maxPages, checkExternal,
    });
    const siteWithUser = await db.getSiteById(site.id);
    registerSite({
      id: site.id,
      url: site.url,
      name: site.name,
      ownerEmail: siteWithUser?.users?.email || req.user.email,
      schedule: site.schedule,
      maxPages: site.max_pages,
      checkExternal: site.check_external,
    });
    ok(res, { site }, 201);
  } catch (e) {
    err(res, e.message);
  }
});

router.get('/sites', requireUser, async (req, res) => {
  try {
    const sites = await db.getSitesByUser(req.user.id);
    ok(res, { sites });
  } catch (e) {
    err(res, e.message);
  }
});

router.delete('/sites/:id', requireUser, async (req, res) => {
  try {
    await db.deleteSite(req.params.id, req.user.id);
    unregisterSite(req.params.id);
    ok(res, { removed: true });
  } catch (e) {
    err(res, e.message, 404);
  }
});

// ── Scans ─────────────────────────────────────────────────────────────────────

// Track in-progress ad-hoc scans (no siteId) to prevent duplication
const activeAdHocScans = new Set();

router.post('/scans', requireUser, scanLimiter, async (req, res) => {
  if (req.user.subscription_status !== 'active') {
    return err(res, 'Active subscription required', 403);
  }

  const { siteId, checkExternal = true, email, siteName } = req.body;
  let { url } = req.body;

  if (!url && siteId) {
    // Fetch url from DB, verify ownership
    const site = await db.getSiteById(siteId);
    if (!site || site.user_id !== req.user.id) return err(res, 'Site not found', 404);
    url = site.url;
  }
  if (!url) return err(res, 'url is required');
  try { new URL(url); } catch { return err(res, 'Invalid URL'); }

  // Enforce plan page limit
  const plan = PLANS[req.user.plan];
  const maxPages = plan ? plan.maxPages : 50;

  // Prevent duplicate scans of same URL
  if (activeAdHocScans.has(url)) {
    return err(res, 'A scan is already in progress for this URL', 409);
  }

  const scanId = crypto.randomUUID();
  ok(res, { scanId, message: 'Scan started', url }, 202);

  activeAdHocScans.add(url);
  setImmediate(async () => {
    try {
      console.log(`[${scanId}] Starting on-demand scan: ${url}`);
      const results = await crawl(url, maxPages, { checkExternal, quiet: false });
      console.log(`[${scanId}] Scan complete. ${results.broken.length} broken links.`);
      if (siteId) {
        await db.saveScan(siteId, results);
        console.log(`[${scanId}] Saved to DB for site ${siteId}`);
      }
      if (email) {
        await sendReport({ to: email, siteName: siteName || url, siteUrl: url, results });
        console.log(`[${scanId}] Report emailed to ${email}`);
      }
    } catch (e) {
      console.error(`[${scanId}] Scan failed:`, e.message);
    } finally {
      activeAdHocScans.delete(url);
    }
  });
});

router.post('/scans/now/:siteId', requireUser, scanLimiter, async (req, res) => {
  try {
    // Verify the site belongs to this user
    const site = await db.getSiteById(req.params.siteId);
    if (!site || site.user_id !== req.user.id) return err(res, 'Site not found', 404);
    await scanNow(req.params.siteId);
    ok(res, { message: `Scan triggered for site ${req.params.siteId}` });
  } catch (e) {
    err(res, e.message, 404);
  }
});

router.get('/scans/:siteId', requireUser, async (req, res) => {
  try {
    // Verify ownership before returning scan history
    const site = await db.getSiteById(req.params.siteId);
    if (!site || site.user_id !== req.user.id) return err(res, 'Site not found', 404);
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const scans = await db.getScanHistory(req.params.siteId, limit);
    ok(res, { scans });
  } catch (e) {
    err(res, e.message);
  }
});

// Quick scan — authenticated, rate-limited
router.post('/scans/quick', requireUser, scanLimiter, async (req, res) => {
  const { url } = req.body;
  if (!url) return err(res, 'url is required');
  try { new URL(url); } catch { return err(res, 'Invalid URL'); }

  if (activeAdHocScans.has(url)) {
    return err(res, 'A scan is already in progress for this URL', 409);
  }

  try {
    activeAdHocScans.add(url);
    const results = await crawl(url, 10, { checkExternal: false, quiet: true });
    ok(res, {
      url: results.startUrl,
      checked: results.checked,
      pagesCrawled: results.pagesCrawled,
      broken: results.broken,
      finishedAt: results.finishedAt,
    });
  } catch (e) {
    err(res, `Scan failed: ${e.message}`);
  } finally {
    activeAdHocScans.delete(url);
  }
});

module.exports = router;