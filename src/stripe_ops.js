import { Hono } from 'hono';
import Stripe from 'stripe';
import { admin } from './db.js';
import { requireUser } from './helpers.js';

const stripeOps = new Hono();

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key, { apiVersion: '2024-11-20.acacia' });
}

stripeOps.post('/create-checkout', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const stripe = getStripe();
    if (!stripe) {
      return c.json({
        error: 'stripe_not_configured',
        message: 'Defina STRIPE_SECRET_KEY e STRIPE_PRICE_ID no ambiente.',
      }, 501);
    }

    const body = await c.req.json().catch(() => ({}));
    const priceId = body.price_id || process.env.STRIPE_PRICE_ID;
    const successUrl = body.success_url || `${process.env.APP_URL || 'http://localhost:5173'}/assinatura?success=1`;
    const cancelUrl = body.cancel_url || `${process.env.APP_URL || 'http://localhost:5173'}/assinatura?canceled=1`;

    if (!priceId) return c.json({ error: 'price_id obrigatório' }, 400);

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: user.email,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { user_id: user.id },
      client_reference_id: user.id,
    });

    return c.json({ url: session.url, session_id: session.id });
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

stripeOps.post('/stripe-webhook', async (c) => {
  try {
    const stripe = getStripe();
    if (!stripe) return c.json({ error: 'stripe_not_configured' }, 501);
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);

    const sig = c.req.header('stripe-signature');
    const raw = await c.req.text();
    const secret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    if (secret && sig) {
      event = stripe.webhooks.constructEvent(raw, sig, secret);
    } else {
      event = JSON.parse(raw);
    }

    const type = event.type;
    const obj = event.data?.object;

    if (type === 'checkout.session.completed' && obj) {
      const userId = obj.metadata?.user_id || obj.client_reference_id;
      if (userId) {
        await admin.from('subscription').upsert({
          user_id: userId,
          status: 'active',
          stripe_customer_id: obj.customer,
          stripe_subscription_id: obj.subscription,
          plan: 'pro',
        });
        await admin.from('subscription_log').insert({
          user_id: userId,
          event: 'checkout_completed',
          details: { session_id: obj.id },
        });
      }
    }

    if (type === 'customer.subscription.updated' || type === 'customer.subscription.deleted') {
      const status = obj.status === 'active' || obj.status === 'trialing' ? 'active' : 'canceled';
      const userId = obj.metadata?.user_id;
      if (userId) {
        await admin.from('subscription').update({
          status: type.endsWith('deleted') ? 'canceled' : status,
          stripe_subscription_id: obj.id,
        }).eq('user_id', userId);
      }
    }

    return c.json({ received: true });
  } catch (error) {
    console.error('stripe-webhook', error);
    return c.json({ error: error.message }, 400);
  }
});

stripeOps.post('/init-subscription', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);

    const { data: existing } = await admin
      .from('subscription')
      .select('*')
      .eq('user_id', user.id)
      .limit(1);

    if (existing?.length) return c.json({ subscription: existing[0] });

    const trialDays = Number(process.env.TRIAL_DAYS || 14);
    const trialEnd = new Date(Date.now() + trialDays * 86400000).toISOString();

    const { data, error } = await admin.from('subscription').insert({
      user_id: user.id,
      status: 'trialing',
      plan: 'trial',
      trial_ends_at: trialEnd,
    }).select().single();

    if (error) return c.json({ error: error.message }, 400);
    return c.json({ subscription: data });
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

stripeOps.post('/link-referral', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);

    const body = await c.req.json().catch(() => ({}));
    const code = String(body.referral_code || body.referralCode || '').trim().toUpperCase();
    if (!code) return c.json({ ok: false, message: 'Informe um código de indicação.' });

    const master = (process.env.MASTER_REFERRAL_CODE || '').toUpperCase();
    if (master && code === master) {
      await admin.from('subscription').upsert({
        user_id: user.id,
        status: 'active',
        plan: 'lifetime',
        is_lifetime: true,
      });
      return c.json({ ok: true, message: 'Acesso permanente liberado!' });
    }

    // find referrer in profiles
    const { data: candidates } = await admin.from('profiles').select('*').eq('referral_code', code).limit(1);
    const referrer = candidates?.[0];
    if (!referrer) return c.json({ ok: false, message: 'Código de indicação inválido.' });
    if (referrer.id === user.id) {
      return c.json({ ok: false, message: 'Você não pode usar seu próprio código de indicação.' });
    }

    if (user.data?.referred_by_user_id || user.referred_by_user_id) {
      return c.json({ ok: false, message: 'Este usuário já está vinculado a um indicador.' });
    }

    await admin.from('profiles').update({
      referred_by_code: code,
      referred_by_user_id: referrer.id,
    }).eq('id', user.id);

    await admin.from('referral').insert({
      referrer_user_id: referrer.id,
      referrer_code: code,
      referred_user_id: user.id,
      referred_email: user.email,
      status: 'pending',
      months_subscribed: 0,
      longterm_granted: false,
    });

    return c.json({ ok: true, message: 'Indicação vinculada com sucesso!' });
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

export default stripeOps;
