import { Hono } from 'hono';
import Stripe from 'stripe';
import { admin, restQuery } from './db.js';
import { requireUser } from './helpers.js';
import { cacheGet, cacheSet } from './cache.js';

const stripeOps = new Hono();

const TRIAL_DAYS = 30;
const MONTHLY_PRICE_BRL = 100;
const DISCOUNT_PRICE_BRL = 50;
const DISCOUNT_MIN_REFERRALS = 6;
const DISCOUNT_MIN_MONTHS_EACH = 6;
const MASTER_CODE = 'DAROCHADEV';
const MASTER_CODE_MAX_USES = 3;
const ACCESS_CACHE_TTL_MS = 60_000;

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key, { apiVersion: '2024-11-20.acacia' });
}

/** Gera código de indicação único (8 chars, sem ambíguos) */
export function generateReferralCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export async function ensureUniqueReferralCode() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = generateReferralCode();
    try {
      const rows = await restQuery(
        `profiles?referral_code=eq.${encodeURIComponent(code)}&select=id&limit=1`
      );
      if (!rows?.length) return code;
    } catch {
      if (admin) {
        const { data } = await admin.from('profiles').select('id').eq('referral_code', code).limit(1);
        if (!data?.length) return code;
      } else {
        return code;
      }
    }
  }
  return generateReferralCode() + Date.now().toString(36).slice(-2).toUpperCase();
}

/**
 * Normaliza payload de acesso para o frontend (camelCase + aliases legados).
 * Front espera: hasAccess, status "trial", daysLeft.
 */
function withFrontendAccessFields(access) {
  if (!access || typeof access !== 'object') return access;
  const out = { ...access };
  const allowed = access.allowed === true;
  out.hasAccess = allowed;
  out.allowed = allowed;

  // Frontend usa "trial"; DB/Stripe usam "trialing"
  if (access.status === 'trialing') {
    out.status = 'trial';
    out.status_raw = 'trialing';
  }

  if (access.days_left != null) {
    out.daysLeft = access.days_left;
    out.days_left = access.days_left;
  }

  if (access.price_brl != null) {
    out.price = access.price_brl;
    out.price_brl = access.price_brl;
  }

  return out;
}

/**
 * Status de acesso do usuário.
 * free / trial / active / lifetime / past_due / expired
 */
export async function getAccessStatus(userId) {
  if (!admin || !userId) {
    return withFrontendAccessFields({ allowed: false, status: 'unknown', description: 'no_user' });
  }

  const cacheKey = `access:${userId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const { data: subs } = await admin
    .from('subscription')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1);

  const sub = subs?.[0];
  let result;
  if (!sub) {
    result = withFrontendAccessFields({ allowed: false, status: 'none', description: 'no_subscription' });
  } else if (sub.permanent_free_access === true || sub.plan === 'lifetime' || sub.plan === 'dev_lifetime') {
    result = withFrontendAccessFields({
      allowed: true,
      status: 'lifetime',
      subscription: sub,
      price_brl: 0,
    });
  } else if (sub.status === 'active') {
    const price = sub.permanent_discount_active === true ? DISCOUNT_PRICE_BRL : MONTHLY_PRICE_BRL;
    result = withFrontendAccessFields({
      allowed: true,
      status: 'active',
      subscription: sub,
      price_brl: price,
    });
  } else if (sub.status === 'trialing') {
    const ends = sub.trial_end ? new Date(sub.trial_end) : null;
    if (ends && ends.getTime() > Date.now()) {
      const daysLeft = Math.ceil((ends.getTime() - Date.now()) / 86400000);
      result = withFrontendAccessFields({
        allowed: true,
        status: 'trialing',
        subscription: sub,
        trial_end: sub.trial_end,
        days_left: daysLeft,
        price_brl: MONTHLY_PRICE_BRL,
      });
    } else {
      result = withFrontendAccessFields({
        allowed: false,
        status: 'trial_expired',
        subscription: sub,
        trial_end: sub.trial_end,
        description: 'trial_expired',
        price_brl: MONTHLY_PRICE_BRL,
      });
    }
  } else if (sub.reward_free_months > 0) {
    result = withFrontendAccessFields({
      allowed: true,
      status: 'free_credit',
      subscription: sub,
      reward_free_months: sub.reward_free_months,
      price_brl: sub.permanent_discount_active ? DISCOUNT_PRICE_BRL : MONTHLY_PRICE_BRL,
    });
  } else {
    result = withFrontendAccessFields({
      allowed: false,
      status: sub.status || 'expired',
      subscription: sub,
      description: 'subscription_inactive',
      price_brl: MONTHLY_PRICE_BRL,
    });
  }

  cacheSet(cacheKey, result, ACCESS_CACHE_TTL_MS);
  return result;
}

/** Garante que o perfil tenha referral_code (usuários antigos / bootstrap falhou) */
export async function ensureUserReferralCode(userId) {
  if (!userId) return null;

  // Lê via PostgREST direto (contorna RLS de forma mais confiável que o client js)
  let profile = null;
  try {
    const rows = await restQuery(
      `profiles?id=eq.${encodeURIComponent(userId)}&select=id,referral_code&limit=1`
    );
    profile = Array.isArray(rows) ? rows[0] : null;
  } catch (e) {
    console.error('ensureUserReferralCode rest select', e.message || e);
    // fallback supabase-js
    if (admin) {
      const { data } = await admin.from('profiles').select('id,referral_code').eq('id', userId).maybeSingle();
      profile = data;
    }
  }

  if (!profile) {
    // Tenta criar perfil mínimo se não existir
    try {
      const inserted = await restQuery('profiles', {
        method: 'POST',
        body: { id: userId, referral_code: await ensureUniqueReferralCode() },
        prefer: 'return=representation,resolution=merge-duplicates',
      });
      const row = Array.isArray(inserted) ? inserted[0] : inserted;
      if (row?.referral_code) return String(row.referral_code).toUpperCase();
    } catch (e) {
      console.error('ensureUserReferralCode insert profile', e.message || e);
    }
    return null;
  }

  if (profile.referral_code && String(profile.referral_code).trim()) {
    return String(profile.referral_code).trim().toUpperCase();
  }

  const code = await ensureUniqueReferralCode();
  try {
    const updated = await restQuery(
      `profiles?id=eq.${encodeURIComponent(userId)}`,
      { method: 'PATCH', body: { referral_code: code }, prefer: 'return=representation' }
    );
    const row = Array.isArray(updated) ? updated[0] : updated;
    return (row?.referral_code || code).toUpperCase();
  } catch (e) {
    console.error('ensureUserReferralCode rest update', e.message || e);
    if (admin) {
      const { data, error } = await admin
        .from('profiles')
        .update({ referral_code: code })
        .eq('id', userId)
        .select('id,referral_code')
        .maybeSingle();
      if (error) console.error('ensureUserReferralCode js update', error.message);
      return data?.referral_code || code;
    }
    return code;
  }
}

/**
 * Aplica código coringa DAROCHADEV → lifetime (máx. MASTER_CODE_MAX_USES usos).
 * Pode ser chamado no registro ou depois (link-referral / conta já existente).
 */
async function applyMasterCodeLifetime(userId, email) {
  if (!admin || !userId) {
    return { ok: false, message: 'Usuário inválido.' };
  }

  // Já é lifetime?
  const access = await getAccessStatus(userId);
  if (access?.status === 'lifetime' || access?.subscription?.permanent_free_access === true) {
    return { ok: true, message: 'Esta conta já possui acesso vitalício.', already: true };
  }

  const { data: usages } = await admin
    .from('subscription_log')
    .select('id')
    .eq('action', 'master_code_used');
  const count = usages?.length || 0;
  if (count >= MASTER_CODE_MAX_USES) {
    return {
      ok: false,
      message: 'Código coringa esgotado (limite de usos atingido).',
      exhausted: true,
    };
  }

  // Atualiza subscription existente ou cria
  const { data: subs } = await admin
    .from('subscription')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1);
  const prev = subs?.[0];

  if (prev) {
    await admin
      .from('subscription')
      .update({
        status: 'active',
        plan: 'lifetime',
        permanent_free_access: true,
        trial_end: null,
      })
      .eq('id', prev.id);
  } else {
    await admin.from('subscription').insert({
      user_id: userId,
      user_email: email || null,
      status: 'active',
      plan: 'lifetime',
      amount: 0,
      permanent_free_access: true,
      reward_free_months: 0,
      permanent_discount_active: false,
    });
  }

  await admin.from('subscription_log').insert({
    user_id: userId,
    action: 'master_code_used',
    description: JSON.stringify({
      code: MASTER_CODE,
      user_email: email || null,
      used_at: new Date().toISOString(),
      via: 'apply_master',
    }),
  });
  await admin.from('subscription_log').insert({
    user_id: userId,
    action: 'dev_lifetime_granted',
    description: JSON.stringify({ code: MASTER_CODE, via: 'apply_master' }),
  });

  return {
    ok: true,
    message: 'Código coringa aplicado! Acesso vitalício liberado.',
    lifetime: true,
  };
}

/** Cria trial de 30 dias + código de indicação no registro */
export async function bootstrapNewUserSubscription(userId, email, referralCodeUsed) {
  if (!admin || !userId) return null;

  const trialEnd = new Date(Date.now() + TRIAL_DAYS * 86400000).toISOString();
  const ownCode = await ensureUniqueReferralCode();

  try {
    await restQuery(
      `profiles?id=eq.${encodeURIComponent(userId)}`,
      { method: 'PATCH', body: { referral_code: ownCode }, prefer: 'return=minimal' }
    );
  } catch (e) {
    console.warn('bootstrap referral_code patch', e.message || e);
    await admin.from('profiles').update({ referral_code: ownCode }).eq('id', userId);
  }

  let plan = 'trial';
  let status = 'trialing';
  let isLifetime = false;
  let masterUsed = false;

  // Código coringa da equipe
  const usedCode = String(referralCodeUsed || '').trim().toUpperCase();
  if (usedCode === MASTER_CODE) {
    // Conta usos via subscription_log (sem tabela extra)
    const { data: usages } = await admin
      .from('subscription_log')
      .select('id')
      .eq('action', 'master_code_used');
    const count = usages?.length || 0;
    if (count >= MASTER_CODE_MAX_USES) {
      // código esgotado — segue como trial normal
    } else {
      plan = 'dev_lifetime';
      status = 'active';
      isLifetime = true;
      masterUsed = true;
      await admin.from('subscription_log').insert({
        user_id: userId,
        action: 'master_code_used',
        description: JSON.stringify({ code: MASTER_CODE, user_email: email || null, used_at: new Date().toISOString() }),
      });
    }
  }

  const { data: sub, error } = await admin
    .from('subscription')
    .insert({
      user_id: userId,
      user_email: email || null,
      status,
      plan: isLifetime ? 'lifetime' : 'trial',
      amount: 100,
      trial_start: isLifetime ? null : new Date().toISOString(),
      trial_end: isLifetime ? null : trialEnd,
      permanent_free_access: isLifetime,
      reward_free_months: 0,
      permanent_discount_active: false,
    })
    .select()
    .single();

  if (error) {
    console.error('bootstrap subscription', error.message);
  }

  await admin.from('subscription_log').insert({
    user_id: userId,
    action: masterUsed ? 'dev_lifetime_granted' : 'trial_started',
    description: JSON.stringify({
      trial_days: TRIAL_DAYS,
      trial_end: trialEnd,
      referral_code_used: usedCode || null,
      master_used: masterUsed,
    }),
  });

  // Vincular indicação normal (não master)
  if (usedCode && usedCode !== MASTER_CODE) {
    await linkReferralInternal(userId, email, usedCode);
  }

  return { subscription: sub, referral_code: ownCode, master_used: masterUsed };
}

async function linkReferralInternal(userId, email, code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized) return { ok: false, message: 'Código vazio' };

  if (normalized === MASTER_CODE) {
    return { ok: false, message: 'Código inválido' };
  }

  const { data: candidates } = await admin
    .from('profiles')
    .select('id,email,referral_code')
    .eq('referral_code', normalized)
    .limit(1);
  const referrer = candidates?.[0];
  if (!referrer) return { ok: false, message: 'Código de indicação inválido.' };
  if (referrer.id === userId) {
    return { ok: false, message: 'Você não pode usar seu próprio código de indicação.' };
  }

  const { data: profile } = await admin
    .from('profiles')
    .select('referred_by_user_id')
    .eq('id', userId)
    .maybeSingle();
  if (profile?.referred_by_user_id) {
    return { ok: false, message: 'Este usuário já está vinculado a um indicador.' };
  }

  await admin
    .from('profiles')
    .update({
      referred_by_code: normalized,
      referred_by_user_id: referrer.id,
    })
    .eq('id', userId);

  await admin.from('referral').insert({
    referrer_user_id: referrer.id,
    referrer_code: normalized,
    referred_user_id: userId,
    referred_email: email || null,
    status: 'pending',
    months_subscribed: 0,
    longterm_granted: false,
    validated_date: null,
  });

  return { ok: true, message: 'Indicação vinculada com sucesso!' };
}

/** Quando o indicado paga a 1ª mensalidade → valida indicação e dá 1 mês grátis ao indicador */
async function processReferralOnFirstPayment(userId) {
  const { data: refs } = await admin
    .from('referral')
    .select('*')
    .eq('referred_user_id', userId)
    .eq('status', 'pending')
    .limit(1);

  const ref = refs?.[0];
  if (!ref) return;

  const now = new Date().toISOString();
  await admin
    .from('referral')
    .update({
      status: 'validated',
      validated_date: now,
      months_subscribed: 1,
    })
    .eq('id', ref.id);

  // Credita 1 mês grátis ao indicador
  const { data: referrerSubs } = await admin
    .from('subscription')
    .select('*')
    .eq('user_id', ref.referrer_user_id)
    .order('created_at', { ascending: false })
    .limit(1);

  const rSub = referrerSubs?.[0];
  if (rSub) {
    const current = Number(rSub.reward_free_months) || 0;
    await admin
      .from('subscription')
      .update({ reward_free_months: current + 1 })
      .eq('id', rSub.id);
  } else {
    await admin.from('subscription').insert({
      user_id: ref.referrer_user_id,
      status: 'active',
      plan: 'referral_credit',
      reward_free_months: 1,
      permanent_free_access: false,
    });
  }

  await admin.from('reward').insert({
    user_id: ref.referrer_user_id,
    type: 'free_month',
    amount: 1,
    description: 'indicação validada',
    related_referral_id: ref.id,
    referred_user_id: userId,
  });

  await admin.from('subscription_log').insert({
    user_id: ref.referrer_user_id,
    action: 'referral_reward_free_month',
    description: JSON.stringify({ related_referral_id: ref.id, referred_user_id: userId }),
  });

  // Recalcula desconto 50%
  await recomputeDiscount50(ref.referrer_user_id);
}

/** Atualiza months_subscribed nas indicações e reavalia desconto 50% */
async function onSubscriptionRenewal(userId) {
  const { data: refs } = await admin
    .from('referral')
    .select('*')
    .eq('referred_user_id', userId)
    .eq('status', 'validated');

  for (const ref of refs || []) {
    const months = (Number(ref.months_subscribed) || 0) + 1;
    await admin.from('referral').update({ months_subscribed: months }).eq('id', ref.id);
  }

  // Quem indicou este usuário pode ganhar/perder desconto
  const referrerId = refs?.[0]?.referrer_user_id;
  if (referrerId) await recomputeDiscount50(referrerId);
  await recomputeDiscount50(userId);
}

async function onSubscriptionCanceled(userId) {
  // Marca indicações deste usuário como inactive se eram validated
  const { data: refs } = await admin
    .from('referral')
    .select('*')
    .eq('referred_user_id', userId)
    .in('status', ['validated', 'pending']);

  for (const ref of refs || []) {
    if (ref.status === 'validated') {
      await admin.from('referral').update({ status: 'inactive' }).eq('id', ref.id);
      if (ref.referrer_user_id) await recomputeDiscount50(ref.referrer_user_id);
    } else if (ref.status === 'pending') {
      await admin.from('referral').update({ status: 'invalidated' }).eq('id', ref.id);
    }
  }
}

/**
 * Desconto 50%: 6 indicações válidas, cada uma com >= 6 meses E ainda ativas.
 */
async function recomputeDiscount50(userId) {
  const { data: refs } = await admin
    .from('referral')
    .select('*')
    .eq('referrer_user_id', userId)
    .eq('status', 'validated');

  const qualifying = [];
  for (const ref of refs || []) {
    const months = Number(ref.months_subscribed) || 0;
    if (months < DISCOUNT_MIN_MONTHS_EACH) continue;

    // Indicado ainda ativo?
    const { data: subRows } = await admin
      .from('subscription')
      .select('status,permanent_free_access')
      .eq('user_id', ref.referred_user_id)
      .order('created_at', { ascending: false })
      .limit(1);
    const s = subRows?.[0];
    const active =
      s &&
      (s.permanent_free_access === true ||
        s.status === 'active' ||
        s.status === 'trialing' ||
        (Number(s.reward_free_months) || 0) > 0);
    if (active) qualifying.push(ref);
  }

  const eligible = qualifying.length >= DISCOUNT_MIN_REFERRALS;

  const { data: subs } = await admin
    .from('subscription')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1);

  const sub = subs?.[0];
  if (!sub) return;

  const currently = sub.permanent_discount_active === true;
  if (eligible !== currently) {
    await admin.from('subscription').update({ permanent_discount_active: eligible }).eq('id', sub.id);
    await admin.from('subscription_log').insert({
      user_id: userId,
      action: eligible ? 'permanent_discount_active_granted' : 'permanent_discount_active_revoked',
      description: JSON.stringify({
        qualifying_count: qualifying.length,
        required: DISCOUNT_MIN_REFERRALS,
      }),
    });
  }
}

// ─── Rotas ─────────────────────────────────────────────────────────────────

stripeOps.post('/create-checkout', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const stripe = getStripe();
    if (!stripe) {
      return c.json({
        error: 'stripe_not_configured',
        message: 'Defina STRIPE_SECRET_KEY e STRIPE_PRICE_ID no ambiente do Render.',
      }, 501);
    }

    const body = await c.req.json().catch(() => ({}));
    const access = await getAccessStatus(user.id);
    const wantsDiscount = access.subscription?.permanent_discount_active === true;

    // Price IDs: normal e com desconto (configuráveis no env)
    const priceId =
      body.price_id ||
      (wantsDiscount
        ? process.env.STRIPE_PRICE_ID_DISCOUNT || process.env.STRIPE_PRICE_ID
        : process.env.STRIPE_PRICE_ID);

    const successUrl =
      body.success_url ||
      `${process.env.APP_URL || 'https://darochapdv.com'}/assinatura?success=1`;
    const cancelUrl =
      body.cancel_url ||
      `${process.env.APP_URL || 'https://darochapdv.com'}/assinatura?canceled=1`;

    if (!priceId) return c.json({ error: 'price_id obrigatório — configure STRIPE_PRICE_ID' }, 400);

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: user.email,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { user_id: user.id },
      client_reference_id: user.id,
      subscription_data: {
        metadata: { user_id: user.id },
      },
    });

    return c.json({
      url: session.url,
      session_id: session.id,
      price_brl: wantsDiscount ? DISCOUNT_PRICE_BRL : MONTHLY_PRICE_BRL,
      permanent_discount_active: wantsDiscount,
    });
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
        const { data: existing } = await admin
          .from('subscription')
          .select('*')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(1);
        const prev = existing?.[0];
        const { count: paidCount } = await admin
          .from('subscription_log')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId)
          .eq('action', 'checkout_completed');
        const isFirstPayment = !prev || (paidCount || 0) === 0 || prev.status === 'trialing' || prev.status === 'trial_expired';

        const upsertPayload = {
          user_id: userId,
          status: 'active',
          stripe_customer_id: obj.customer,
          stripe_subscription_id: obj.subscription,
          plan: 'pro',
          amount: prev?.permanent_discount_active ? 50 : 100,
          permanent_free_access: prev?.permanent_free_access === true,
          permanent_discount_active: prev?.permanent_discount_active === true,
          reward_free_months: Number(prev?.reward_free_months) || 0,
        };
        if (prev?.id) {
          await admin.from('subscription').update(upsertPayload).eq('id', prev.id);
        } else {
          await admin.from('subscription').insert(upsertPayload);
        }

        await admin.from('subscription_log').insert({
          user_id: userId,
          action: 'checkout_completed',
          description: JSON.stringify({ session_id: obj.id, first_payment: isFirstPayment }),
        });

        if (isFirstPayment) {
          await processReferralOnFirstPayment(userId);
        }
      }
    }

    if (type === 'invoice.paid' && obj) {
      const userId = obj.subscription_details?.metadata?.user_id || obj.metadata?.user_id;
      // Busca via stripe_subscription_id
      let uid = userId;
      if (!uid && obj.subscription) {
        const { data: rows } = await admin
          .from('subscription')
          .select('user_id')
          .eq('stripe_subscription_id', obj.subscription)
          .limit(1);
        if (rows?.[0]) {
          uid = rows[0].user_id;
          await admin
            .from('subscription')
            .update({ status: 'active' })
            .eq('user_id', uid);
          await onSubscriptionRenewal(uid);
        }
      } else if (uid) {
        await onSubscriptionRenewal(uid);
      }
    }

    if (type === 'customer.subscription.updated' || type === 'customer.subscription.deleted') {
      const status =
        obj.status === 'active' || obj.status === 'trialing' ? 'active' : 'canceled';
      let userId = obj.metadata?.user_id;
      if (!userId) {
        const { data: rows } = await admin
          .from('subscription')
          .select('user_id')
          .eq('stripe_subscription_id', obj.id)
          .limit(1);
        userId = rows?.[0]?.user_id;
      }
      if (userId) {
        const newStatus = type.endsWith('deleted') ? 'canceled' : status;
        await admin
          .from('subscription')
          .update({
            status: newStatus,
            stripe_subscription_id: obj.id,
          })
          .eq('user_id', userId);

        if (newStatus === 'canceled') {
          await onSubscriptionCanceled(userId);
        }
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

    // Garante código de indicação mesmo para contas antigas
    const referralCode = await ensureUserReferralCode(user.id);

    const { data: existing } = await admin
      .from('subscription')
      .select('*')
      .eq('user_id', user.id)
      .limit(1);

    let subscription = existing?.[0] || null;
    if (!subscription) {
      const result = await bootstrapNewUserSubscription(user.id, user.email, null);
      subscription = result?.subscription || null;
    }

    const access = await getAccessStatus(user.id);
    return c.json({
      subscription,
      access,
      referralCode: referralCode || null,
      referral_code: referralCode || null,
      trialDays: TRIAL_DAYS,
      price: access?.price_brl ?? MONTHLY_PRICE_BRL,
      price_brl: access?.price_brl ?? MONTHLY_PRICE_BRL,
    });
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

stripeOps.post('/subscription-status', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const access = await getAccessStatus(user.id);
    return c.json(access);
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

/** Aliases legados usados pelo frontend (Base44) */
async function handleAccessStatus(c) {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const access = await getAccessStatus(user.id);
    return c.json(access);
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
}
stripeOps.post('/get-access-status', handleAccessStatus);
stripeOps.post('/access-status', handleAccessStatus);



/** Cancela assinatura Stripe do usuário logado (padrão: no fim do período pago) */
stripeOps.post('/cancel-subscription', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);
    const stripe = getStripe();
    if (!stripe) {
      return c.json({ error: 'stripe_not_configured', message: 'Stripe não configurado.' }, 501);
    }

    const body = await c.req.json().catch(() => ({}));
    const immediate = body.immediate === true || body.at_period_end === false;

    const { data: subs } = await admin
      .from('subscription')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1);
    const sub = subs?.[0];
    if (!sub) {
      return c.json({ ok: false, message: 'Nenhuma assinatura encontrada.' }, 404);
    }
    if (sub.permanent_free_access === true || sub.plan === 'lifetime' || sub.plan === 'dev_lifetime') {
      return c.json({ ok: false, message: 'Contas com acesso vitalício não possuem assinatura cancelável no Stripe.' }, 400);
    }

    const stripeSubId = sub.stripe_subscription_id;
    if (!stripeSubId) {
      return c.json({
        ok: false,
        message: 'Não há assinatura Stripe vinculada a esta conta. Se você acabou de pagar, aguarde alguns minutos ou contate o suporte.',
      }, 400);
    }

    let stripeSub;
    if (immediate) {
      stripeSub = await stripe.subscriptions.cancel(stripeSubId);
    } else {
      stripeSub = await stripe.subscriptions.update(stripeSubId, { cancel_at_period_end: true });
    }

    const periodEnd = stripeSub.current_period_end
      ? new Date(stripeSub.current_period_end * 1000).toISOString()
      : sub.current_period_end;

    const updatePayload = {
      cancel_at_period_end: !immediate,
      current_period_end: periodEnd || sub.current_period_end,
    };
    if (immediate || stripeSub.status === 'canceled') {
      updatePayload.status = 'canceled';
      updatePayload.cancel_at_period_end = false;
    }

    await admin.from('subscription').update(updatePayload).eq('id', sub.id);
    await admin.from('subscription_log').insert({
      user_id: user.id,
      action: immediate ? 'subscription_canceled_immediate' : 'subscription_cancel_at_period_end',
      description: JSON.stringify({
        stripe_subscription_id: stripeSubId,
        current_period_end: periodEnd,
      }),
    });

    if (immediate) {
      try {
        await onSubscriptionCanceled(user.id);
      } catch (e) {
        console.warn('onSubscriptionCanceled', e.message || e);
      }
    }

    const access = await getAccessStatus(user.id);
    return c.json({
      ok: true,
      immediate,
      cancel_at_period_end: !immediate && stripeSub.cancel_at_period_end === true,
      current_period_end: periodEnd,
      message: immediate
        ? 'Assinatura cancelada imediatamente.'
        : `Cancelamento agendado. Você continua com acesso até ${periodEnd ? new Date(periodEnd).toLocaleDateString('pt-BR') : 'o fim do período pago'}.`,
      access,
      subscription: { ...sub, ...updatePayload },
    });
  } catch (error) {
    console.error('cancel-subscription', error);
    return c.json({ error: error.message }, 500);
  }
});

/** Reativa cobrança se o cancelamento estava só agendado (cancel_at_period_end) */
stripeOps.post('/resume-subscription', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);
    const stripe = getStripe();
    if (!stripe) return c.json({ error: 'stripe_not_configured' }, 501);

    const { data: subs } = await admin
      .from('subscription')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1);
    const sub = subs?.[0];
    if (!sub?.stripe_subscription_id) {
      return c.json({ ok: false, message: 'Nenhuma assinatura Stripe encontrada.' }, 404);
    }

    const stripeSub = await stripe.subscriptions.update(sub.stripe_subscription_id, {
      cancel_at_period_end: false,
    });

    await admin.from('subscription').update({
      cancel_at_period_end: false,
      status: 'active',
    }).eq('id', sub.id);

    await admin.from('subscription_log').insert({
      user_id: user.id,
      action: 'subscription_resumed',
      description: JSON.stringify({ stripe_subscription_id: sub.stripe_subscription_id }),
    });

    const access = await getAccessStatus(user.id);
    return c.json({
      ok: true,
      message: 'Assinatura reativada. As cobranças continuarão normalmente.',
      access,
    });
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

    // Código coringa da equipe (aceita também após o cadastro, enquanto houver usos)
    if (code === MASTER_CODE) {
      const result = await applyMasterCodeLifetime(user.id, user.email);
      return c.json(result);
    }

    const result = await linkReferralInternal(user.id, user.email, code);
    return c.json(result);
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

/** Painel de indicações do usuário */
stripeOps.post('/referral-panel', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);

    // Garante código próprio
    await ensureUserReferralCode(user.id);

    const { data: profile } = await admin
      .from('profiles')
      .select('referral_code,referred_by_code,referred_by_user_id')
      .eq('id', user.id)
      .maybeSingle();

    const { data: referrals } = await admin
      .from('referral')
      .select('*')
      .eq('referrer_user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(200);

    const list = referrals || [];
    const total = list.length;
    const validated = list.filter((r) => r.status === 'validated' || r.status === 'inactive');
    const validatedActive = list.filter((r) => r.status === 'validated');
    const pending = list.filter((r) => r.status === 'pending');

    const { data: rewards } = await admin
      .from('reward')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(100);

    const freeMonthsEarned = (rewards || [])
      .filter((r) => r.type === 'free_month')
      .reduce((s, r) => s + (Number(r.amount) || 0), 0);

    const access = await getAccessStatus(user.id);
    const freeRemaining = Number(access.subscription?.reward_free_months) || 0;

    // Progresso para desconto 50%
    let longtermCount = 0;
    for (const r of validatedActive) {
      if ((Number(r.months_subscribed) || 0) >= DISCOUNT_MIN_MONTHS_EACH) longtermCount++;
    }

    return c.json({
      referral_code: profile?.referral_code || null,
      total_indicated: total,
      validated_count: validated.length,
      pending_count: pending.length,
      active_indicated: validatedActive.length,
      free_months_earned: freeMonthsEarned,
      reward_free_months: freeRemaining,
      permanent_discount_active: access.subscription?.permanent_discount_active === true,
      discount_progress: {
        current: longtermCount,
        required: DISCOUNT_MIN_REFERRALS,
        min_months_each: DISCOUNT_MIN_MONTHS_EACH,
      },
      price_brl: access.subscription?.permanent_discount_active ? DISCOUNT_PRICE_BRL : MONTHLY_PRICE_BRL,
      referrals: list.map((r) => ({
        id: r.id,
        referred_email: r.referred_email,
        status: r.status,
        months_subscribed: r.months_subscribed || 0,
        validated_date: r.validated_date,
        created_at: r.created_at,
      })),
      rewards: rewards || [],
      access,
    });
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

/** Força geração/retorno do código de indicação do usuário logado */
stripeOps.post('/ensure-referral-code', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const code = await ensureUserReferralCode(user.id);
    let profile = null;
    let readError = null;
    try {
      const rows = await restQuery(
        `profiles?id=eq.${encodeURIComponent(user.id)}&select=id,email,referral_code,referred_by_code,referred_by_user_id&limit=1`
      );
      profile = Array.isArray(rows) ? rows[0] : null;
    } catch (e) {
      readError = e.message || String(e);
    }
    return c.json({
      ok: !!code,
      user_id: user.id,
      referral_code: code || profile?.referral_code || null,
      profile,
      readError,
    });
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

/** Uso interno: status do código master (só loga, não expõe na UI) */

stripeOps.post('/master-code-status', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    // Só admins da equipe (email conhecidos ou role)
    const allowed = (process.env.DEV_ADMIN_EMAILS || 'darochapdv@gmail.com')
      .split(',')
      .map((e) => e.trim().toLowerCase());
    if (!allowed.includes(String(user.email || '').toLowerCase())) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const { data: usages } = await admin
      .from('subscription_log')
      .select('*')
      .eq('action', 'master_code_used')
      .order('created_at', { ascending: false });
    return c.json({
      code: MASTER_CODE,
      used: usages?.length || 0,
      max: MASTER_CODE_MAX_USES,
      remaining: Math.max(0, MASTER_CODE_MAX_USES - (usages?.length || 0)),
      usages: usages || [],
    });
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

export default stripeOps;
export { TRIAL_DAYS, MONTHLY_PRICE_BRL, MASTER_CODE };
