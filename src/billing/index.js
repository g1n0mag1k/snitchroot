require('dotenv').config();

// Lazy-init Stripe so the module loads safely even without STRIPE_SECRET_KEY set.
let _stripe = null;
function stripe() {
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY is not set');
    }
    _stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  }
  return _stripe;
}

const PLANS = {
  pro: {
    name: 'Pro',
    priceId: () => process.env.STRIPE_PRO_PRICE_ID,
    amount: 1900,
    currency: 'usd',
    interval: 'month',
    maxSites: 5,
    maxPages: 200,
  },
  agency: {
    name: 'Agency',
    priceId: () => process.env.STRIPE_AGENCY_PRICE_ID,
    amount: 4900,
    currency: 'usd',
    interval: 'month',
    maxSites: 25,
    maxPages: 500,
  },
};

/**
 * Create or retrieve a Stripe customer for a user.
 *
 * @param {object} opts
 * @param {string} opts.email
 * @param {string} [opts.name]
 * @param {string} [opts.existingCustomerId]  Pass if already stored in your DB.
 * @returns {Promise<string>} Stripe customer id
 */
async function getOrCreateCustomer({ email, name, existingCustomerId }) {
  if (existingCustomerId) {
    return existingCustomerId;
  }

  // Check if a customer already exists with this email to avoid duplicates.
  const existing = await stripe().customers.list({ email, limit: 1 });
  if (existing.data.length > 0) {
    return existing.data[0].id;
  }

  const customer = await stripe().customers.create({
    email,
    name: name || email,
    metadata: { source: 'snitchroot' },
  });
  return customer.id;
}

/**
 * Create a Stripe Checkout session for a new subscription.
 *
 * @param {object} opts
 * @param {string} opts.customerId     Stripe customer id
 * @param {'pro'|'agency'} opts.plan
 * @param {string} opts.successUrl     Where to redirect after successful payment
 * @param {string} opts.cancelUrl      Where to redirect if user cancels
 * @param {string} [opts.clientReferenceId]  Your internal user id, echoed back in webhook
 * @returns {Promise<{sessionId: string, url: string}>}
 */
async function createCheckoutSession({ customerId, plan, successUrl, cancelUrl, clientReferenceId }) {
  const planConfig = PLANS[plan];
  if (!planConfig) throw new Error(`Unknown plan: "${plan}". Valid options: pro, agency`);

  const priceId = planConfig.priceId();
  if (!priceId) throw new Error(`STRIPE_${plan.toUpperCase()}_PRICE_ID is not set`);

  const session = await stripe().checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    ...(clientReferenceId ? { client_reference_id: clientReferenceId } : {}),
    allow_promotion_codes: true,
    subscription_data: {
      metadata: { plan, source: 'snitchroot' },
    },
  });

  return { sessionId: session.id, url: session.url };
}

/**
 * Create a Stripe Customer Portal session so users can manage/cancel their subscription.
 *
 * @param {object} opts
 * @param {string} opts.customerId
 * @param {string} opts.returnUrl
 * @returns {Promise<string>} Portal URL
 */
async function createPortalSession({ customerId, returnUrl }) {
  const session = await stripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
  return session.url;
}

/**
 * Cancel a subscription immediately.
 *
 * @param {string} subscriptionId
 * @returns {Promise<object>} Cancelled subscription object
 */
async function cancelSubscription(subscriptionId) {
  return stripe().subscriptions.cancel(subscriptionId);
}

/**
 * Retrieve an active subscription's plan info.
 *
 * @param {string} subscriptionId
 * @returns {Promise<{plan: string, status: string, currentPeriodEnd: Date}|null>}
 */
async function getSubscriptionInfo(subscriptionId) {
  try {
    const sub = await stripe().subscriptions.retrieve(subscriptionId, {
      expand: ['items.data.price'],
    });

    // Match the Stripe price id back to our plan slug.
    const priceId = sub.items.data[0]?.price?.id;
    const plan = Object.entries(PLANS).find(
      ([, cfg]) => cfg.priceId() === priceId
    )?.[0] || 'unknown';

    return {
      plan,
      status: sub.status,
      currentPeriodEnd: new Date(sub.current_period_end * 1000),
    };
  } catch {
    return null;
  }
}

/**
 * Verify and parse an incoming Stripe webhook payload.
 * Call this from your Express webhook route — pass the raw body buffer, not parsed JSON.
 *
 * @param {Buffer} rawBody
 * @param {string} signature   Value of the `stripe-signature` header
 * @returns {import('stripe').Stripe.Event}
 */
function constructWebhookEvent(rawBody, signature) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not set');
  return stripe().webhooks.constructEvent(rawBody, signature, secret);
}

/**
 * Handle a verified Stripe webhook event and return a normalized action object.
 * Your API layer calls this after constructWebhookEvent() succeeds.
 *
 * Returned action shapes:
 *   { type: 'subscription.activated', customerId, subscriptionId, plan }
 *   { type: 'subscription.cancelled', customerId, subscriptionId }
 *   { type: 'payment.failed',         customerId, subscriptionId, invoiceId }
 *   { type: 'ignored',                eventType }
 *
 * @param {import('stripe').Stripe.Event} event
 * @returns {object}
 */
function handleWebhookEvent(event) {
  const obj = event.data.object;

  switch (event.type) {
    case 'checkout.session.completed': {
      // A checkout completed — subscription is now active.
      return {
        type: 'subscription.activated',
        customerId: obj.customer,
        subscriptionId: obj.subscription,
        clientReferenceId: obj.client_reference_id,
        plan: obj.metadata?.plan || null,
      };
    }

    case 'customer.subscription.updated': {
      const plan = obj.metadata?.plan || null;
      const active = ['active', 'trialing'].includes(obj.status);
      return {
        type: active ? 'subscription.activated' : 'subscription.cancelled',
        customerId: obj.customer,
        subscriptionId: obj.id,
        plan,
        status: obj.status,
      };
    }

    case 'customer.subscription.deleted': {
      return {
        type: 'subscription.cancelled',
        customerId: obj.customer,
        subscriptionId: obj.id,
      };
    }

    case 'invoice.payment_failed': {
      return {
        type: 'payment.failed',
        customerId: obj.customer,
        subscriptionId: obj.subscription,
        invoiceId: obj.id,
      };
    }

    default:
      return { type: 'ignored', eventType: event.type };
  }
}

module.exports = {
  PLANS,
  getOrCreateCustomer,
  createCheckoutSession,
  createPortalSession,
  cancelSubscription,
  getSubscriptionInfo,
  constructWebhookEvent,
  handleWebhookEvent,
};
