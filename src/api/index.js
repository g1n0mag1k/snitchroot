require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
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

function ok(res, data, status = 200) {
  return res.status(status).json({ ok: true, ...data });
}
function err(res, message, status = 400) {
  return res.status(status).json({ ok: false, error: message });
}
function requireAuth(req, res, next) {
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
router.post('/billing/checkout', async (req, res) => {
  try {
    const { email, name, plan, userId } = req.body;
    if (!email || !plan) return err(res, 'email and plan are required');
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

router.post('/billing/portal', requireAuth, async (req, res) => {
  try {
    const { customerId } = req.body;
    if (!customerId) return err(res, 'customerId is required');
    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    const url = await createPortalSession({ customerId, returnUrl: `${appUrl}/dashboard` });
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
router.post('/sites', requireAuth, async (req, res) => {
  try {
    const { userId, url, name, schedule, maxPages, checkExternal } = req.body;
    if (!userId || !url || !name) return err(res, 'userId, url, and name are required');
    try { new URL(url); } catch { return err(res, 'Invalid URL'); }

    const site = await db.createSite({ userId, url, name, schedule, maxPages, checkExternal });
    const siteWithUser = await db.getSiteById(site.id);
    registerSite({
      id: site.id,
      url: site.url,
      name: site.name,
      ownerEmail: siteWithUser?.users?.email || '',
      schedule: site.schedule,
      maxPages: site.max_pages,
      checkExternal: site.check_external,
    });
    ok(res, { site }, 201);
  } catch (e) {
    err(res, e.message);
  }
});

router.get('/sites', requireAuth, async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return err(res, 'userId query param required');
    const sites = await db.getSitesByUser(userId);
    ok(res, { sites });
  } catch (e) {
    err(res, e.message);
  }
});

router.delete('/sites/:id', requireAuth, async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return err(res, 'userId is required');
    await db.deleteSite(req.params.id, userId);
    unregisterSite(req.params.id);
    ok(res, { removed: true });
  } catch (e) {
    err(res, e.message, 404);
  }
});

// ── Scans ─────────────────────────────────────────────────────────────────────
router.post('/scans', requireAuth, async (req, res) => {
  const { url, siteId, maxPages = 50, checkExternal = true, email, siteName } = req.body;
  if (!url) return err(res, 'url is required');
  try { new URL(url); } catch { return err(res, 'Invalid URL'); }

  const scanId = crypto.randomUUID();
  ok(res, { scanId, message: 'Scan started', url }, 202);

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
    }
  });
});

router.post('/scans/now/:siteId', requireAuth, async (req, res) => {
  try {
    await scanNow(req.params.siteId);
    ok(res, { message: `Scan triggered for site ${req.params.siteId}` });
  } catch (e) {
    err(res, e.message, 404);
  }
});

router.get('/scans/:siteId', requireAuth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const scans = await db.getScanHistory(req.params.siteId, limit);
    ok(res, { scans });
  } catch (e) {
    err(res, e.message);
  }
});

router.post('/scans/quick', async (req, res) => {
  const { url } = req.body;
  if (!url) return err(res, 'url is required');
  try { new URL(url); } catch { return err(res, 'Invalid URL'); }
  try {
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
  }
});

module.exports = router;
