/**
 * Mercado Pago — multi-lojista (OAuth + Pix + Cartão + Webhook)
 * Cada loja conecta a própria conta e recebe diretamente.
 */
import { Hono } from 'hono';
import crypto from 'crypto';
import { admin } from './db.js';
import { requireUser } from './helpers.js';

const payments = new Hono();

/** Campos extras de pagamento online sem colunas novas no banco */
function encodeOnlinePaymentFields({ payment_status, mp_payment_id, payment_meta, paid_at, status } = {}) {
  const out = {};
  if (status) out.status = status;
  else if (payment_status === 'paid') out.status = 'concluida';
  else if (payment_status === 'pending' || payment_status === 'pending_payment') out.status = 'pending_payment';
  else if (payment_status === 'payment_failed') out.status = 'cancelada';
  const paymentsBlob = {
    online: true,
    provider: 'mercadopago',
    payment_status: payment_status || null,
    mp_payment_id: mp_payment_id || null,
    paid_at: paid_at || null,
    ...(payment_meta && typeof payment_meta === 'object' ? payment_meta : {}),
  };
  out.payments = paymentsBlob;
  if (mp_payment_id) out.client_ref = String(mp_payment_id);
  return out;
}

function readOnlinePayment(sale) {
  if (!sale) return {};
  const p = sale.payments && typeof sale.payments === 'object' && !Array.isArray(sale.payments) ? sale.payments : {};
  return {
    payment_status: p.payment_status
      || (sale.status === 'concluida' ? 'paid' : null)
      || (sale.status === 'pending_payment' ? 'pending' : null),
    mp_payment_id: p.mp_payment_id || sale.client_ref || null,
    payment_meta: p,
    paid_at: p.paid_at || null,
  };
}



const MP_API = 'https://api.mercadopago.com';
const MP_AUTH = 'https://auth.mercadopago.com/authorization';

function env(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}

function getAppCredentials() {
  return {
    clientId: env('MP_CLIENT_ID') || env('MERCADOPAGO_CLIENT_ID'),
    clientSecret: env('MP_CLIENT_SECRET') || env('MERCADOPAGO_CLIENT_SECRET'),
    redirectUri: env('MP_REDIRECT_URI') || env('MERCADOPAGO_REDIRECT_URI') || 'https://api.darochapdv.com/functions/mercadopago-oauth-callback',
    frontendBase: env('FRONTEND_URL') || env('APP_URL') || 'https://darochapdv.com',
  };
}

function encryptionKey() {
  const raw = env('MP_TOKEN_ENCRYPTION_KEY') || env('TOKEN_ENCRYPTION_KEY') || env('JWT_SECRET') || 'darocha-mp-dev-key-change-me';
  return crypto.createHash('sha256').update(raw).digest();
}

function encrypt(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

function decrypt(payload) {
  if (!payload) return '';
  const str = String(payload);
  if (!str.startsWith('v1:')) return str; // legado / texto plano (dev)
  const [, ivB64, tagB64, dataB64] = str.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return dec.toString('utf8');
}

/** Persiste conta MP do lojista em app_settings (JSONB mercadopago) */
async function saveMpAccount(userId, data) {
  const payload = {
    provider: 'mercadopago',
    status: data.status || 'connected',
    provider_user_id: data.provider_user_id || null,
    public_key: data.public_key || null,
    access_token_encrypted: data.access_token ? encrypt(data.access_token) : data.access_token_encrypted || null,
    refresh_token_encrypted: data.refresh_token ? encrypt(data.refresh_token) : data.refresh_token_encrypted || null,
    token_expires_at: data.token_expires_at || null,
    connected_at: data.connected_at || new Date().toISOString(),
    nickname: data.nickname || null,
    email: data.email || null,
  };

  // 1) payment_account (se a tabela existir)
  try {
    const { data: existing } = await admin
      .from('payment_account')
      .select('id')
      .eq('user_id', userId)
      .eq('provider', 'mercadopago')
      .maybeSingle();
    if (existing?.id) {
      const { error } = await admin.from('payment_account').update({
        ...payload,
        updated_at: new Date().toISOString(),
      }).eq('id', existing.id);
      if (error) throw error;
    } else {
      const { error } = await admin.from('payment_account').insert({
        user_id: userId,
        ...payload,
      });
      if (error) throw error;
    }
    return;
  } catch (e) {
    console.warn('payment_account save fallback', e.message || e);
  }

  // 2) app_settings.role_payment_methods.__darocha_mp (coluna já existe)
  const { data: rows, error: selErr } = await admin
    .from('app_settings')
    .select('id,role_payment_methods')
    .eq('created_by', userId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (selErr) throw new Error(selErr.message);
  const row = rows?.[0];
  const current = (row?.role_payment_methods && typeof row.role_payment_methods === 'object' && !Array.isArray(row.role_payment_methods))
    ? { ...row.role_payment_methods }
    : {};
  current.__darocha_mp = payload;
  if (row?.id) {
    const { error } = await admin.from('app_settings').update({ role_payment_methods: current }).eq('id', row.id);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await admin.from('app_settings').insert({ created_by: userId, role_payment_methods: current });
    if (error) throw new Error(error.message);
  }
}

async function loadMpAccount(userId) {
  if (!userId) return null;
  try {
    const { data } = await admin
      .from('payment_account')
      .select('*')
      .eq('user_id', userId)
      .eq('provider', 'mercadopago')
      .maybeSingle();
    if (data?.access_token_encrypted) {
      return {
        status: data.status || 'connected',
        provider_user_id: data.provider_user_id,
        public_key: data.public_key,
        access_token_encrypted: data.access_token_encrypted,
        refresh_token_encrypted: data.refresh_token_encrypted,
        token_expires_at: data.token_expires_at,
        nickname: data.nickname || null,
        email: data.email || null,
      };
    }
  } catch (_) {}

  const { data: rows } = await admin
    .from('app_settings')
    .select('role_payment_methods')
    .eq('created_by', userId)
    .order('created_at', { ascending: false })
    .limit(5);

  for (const r of rows || []) {
    const mp = r?.role_payment_methods?.__darocha_mp || r?.mercadopago;
    if (mp?.access_token_encrypted || mp?.status === 'connected') {
      return mp;
    }
  }
  return null;
}

async function clearMpAccount(userId) {
  try {
    await admin.from('payment_account').delete().eq('user_id', userId).eq('provider', 'mercadopago');
  } catch (_) {}
  const { data: rows } = await admin
    .from('app_settings')
    .select('id,role_payment_methods')
    .eq('created_by', userId)
    .limit(10);
  for (const r of rows || []) {
    if (!r?.id) continue;
    const current = (r.role_payment_methods && typeof r.role_payment_methods === 'object' && !Array.isArray(r.role_payment_methods))
      ? { ...r.role_payment_methods }
      : {};
    if (current.__darocha_mp) {
      current.__darocha_mp = { status: 'disconnected' };
      await admin.from('app_settings').update({ role_payment_methods: current }).eq('id', r.id);
    }
  }
}

async function refreshAccessTokenIfNeeded(userId, account) {
  if (!account?.refresh_token_encrypted) return account;
  const expires = account.token_expires_at ? new Date(account.token_expires_at).getTime() : 0;
  if (expires && expires > Date.now() + 60_000) return account;
  const { clientId, clientSecret } = getAppCredentials();
  if (!clientId || !clientSecret) return account;
  const refreshToken = decrypt(account.refresh_token_encrypted);
  if (!refreshToken) return account;
  const res = await fetch(`${MP_API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    console.warn('mp refresh failed', data);
    return account;
  }
  const updated = await saveMpAccount(userId, {
    status: 'connected',
    provider_user_id: account.provider_user_id || data.user_id,
    public_key: account.public_key,
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    token_expires_at: data.expires_in
      ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString()
      : null,
    nickname: account.nickname,
    email: account.email,
  });
  return updated;
}

async function getAccessTokenForStore(storeOwnerId) {
  let account = await loadMpAccount(storeOwnerId);
  if (!account || account.status === 'disconnected' || !account.access_token_encrypted) {
    return { error: 'Mercado Pago não conectado para esta loja', account: null, token: null };
  }
  account = await refreshAccessTokenIfNeeded(storeOwnerId, account);
  const token = decrypt(account.access_token_encrypted);
  if (!token) return { error: 'Token Mercado Pago inválido', account, token: null };
  return { error: null, account, token };
}


function isValidCpf(raw) {
  const s = String(raw || '').replace(/\D/g, '');
  if (s.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(s[i]) * (10 - i);
  let d1 = (sum * 10) % 11;
  if (d1 === 10) d1 = 0;
  if (d1 !== Number(s[9])) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(s[i]) * (11 - i);
  let d2 = (sum * 10) % 11;
  if (d2 === 10) d2 = 0;
  return d2 === Number(s[10]);
}

function isRealPayerEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return false;
  if (/@darochapdv\.com$/i.test(e)) return false;
  if (/@(example\.com|test\.com|localhost)$/i.test(e)) return false;
  return true;
}

function splitPersonName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first_name: 'Cliente', last_name: 'Final' };
  if (parts.length === 1) return { first_name: parts[0], last_name: 'Cliente' };
  return { first_name: parts[0], last_name: parts.slice(1).join(' ') };
}

function splitBrPhone(raw) {
  let p = String(raw || '').replace(/\D/g, '');
  if (p.startsWith('55') && p.length >= 12) p = p.slice(2);
  if (p.startsWith('0') && p.length > 10) p = p.replace(/^0+/, '');
  if (p.length >= 10 && p.length <= 11) {
    return { area_code: p.slice(0, 2), number: p.slice(2) };
  }
  return null;
}

function clientIpFromRequest(c) {
  try {
    const xff = c.req.header('x-forwarded-for') || c.req.header('X-Forwarded-For');
    if (xff) return String(xff).split(',')[0].trim();
    return (
      c.req.header('x-real-ip')
      || c.req.header('cf-connecting-ip')
      || c.req.header('true-client-ip')
      || ''
    );
  } catch {
    return '';
  }
}

function readDeviceIdFromRequest(c, body) {
  const fromBody = body?.device_id || body?.deviceId || body?.mp_device_session_id || body?.session_id || null;
  const fromHeader = c.req.header('x-meli-session-id') || c.req.header('X-meli-session-id') || null;
  const raw = String(fromBody || fromHeader || '').trim();
  if (!raw || raw === 'null' || raw === 'undefined' || raw.length < 8) return null;
  if (/^(test|fake|dummy|fixed|0000)/i.test(raw)) return null;
  return raw;
}

function classifyMpCardResult(status, statusDetail) {
  const d = String(statusDetail || '');
  if (status === 'approved') return { category: 'approved', user_message: 'Pagamento aprovado.' };
  if (d === 'cc_rejected_high_risk' || d === 'cc_rejected_blacklist' || d === 'rejected_high_risk') {
    return {
      category: 'antifraud',
      user_message: 'Pagamento recusado pela análise de risco do Mercado Pago (' + (d || 'high_risk') + '). Não é erro do Darocha; o antifraude bloqueou a operação.',
    };
  }
  if (d.startsWith('cc_rejected_bad_filled') || d === 'cc_rejected_bad_filled_card_number' || d === 'cc_rejected_bad_filled_date' || d === 'cc_rejected_bad_filled_security_code' || d === 'cc_rejected_bad_filled_other' || d === 'cc_rejected_bad_filled_cardholder') {
    return { category: 'user_data', user_message: 'Dados do cartão ou do titular incorretos. Confira número, validade, CVC, CPF e nome.' };
  }
  if (d === 'cc_rejected_insufficient_amount') {
    return { category: 'issuer', user_message: 'Cartão sem limite/saldo suficiente.' };
  }
  if (d === 'cc_rejected_call_for_authorize' || d === 'cc_rejected_card_disabled' || d === 'cc_rejected_other_reason' || d === 'cc_rejected_max_attempts' || d === 'cc_rejected_duplicated_payment' || d === 'cc_rejected_card_error' || d === 'cc_rejected_invalid_installments') {
    return { category: 'issuer', user_message: 'Cartão recusado pelo banco emissor (' + d + ').' };
  }
  if (status === 'rejected') {
    return { category: 'issuer', user_message: 'Pagamento recusado (' + (d || status) + ').' };
  }
  if (status === 'pending' || status === 'in_process' || status === 'in_mediation') {
    return { category: 'pending', user_message: 'Pagamento em análise.' };
  }
  return { category: 'integration', user_message: 'Status: ' + (status || 'desconhecido') + (d ? ' / ' + d : '') };
}

/**
 * A loja já embute a taxa em sale.total (card_installment_rates).
 * No "parcelado cliente" o MP soma juros no cartão (10,20 → 11,18).
 * Só envia N parcelas se houver plano sem juros com total ≈ sale.total.
 */
async function resolveChargeInstallments(token, {
  amount,
  wantedInstallments,
  bin,
  paymentMethodId,
  isDebit,
}) {
  const wanted = isDebit ? 1 : Math.max(1, Math.min(12, Number(wantedInstallments) || 1));
  if (wanted <= 1) {
    return { installments: 1, issuer_id: null, plan: 'avista', mp_total: amount };
  }
  const binDigits = String(bin || '').replace(/\D/g, '').slice(0, 8);
  if (binDigits.length < 6) {
    return { installments: 1, issuer_id: null, plan: 'fallback_avista_sem_bin', mp_total: amount };
  }
  try {
    const params = new URLSearchParams({
      amount: String(amount),
      bin: binDigits,
    });
    if (paymentMethodId) params.set('payment_method_id', String(paymentMethodId));
    const { ok, data } = await mpFetch(token, `/v1/payment_methods/installments?${params.toString()}`);
    const list = ok && Array.isArray(data) ? data : [];
    for (const issuer of list) {
      const costs = Array.isArray(issuer?.payer_costs) ? issuer.payer_costs : [];
      const cost = costs.find((c) => Number(c.installments) === wanted);
      if (!cost) continue;
      const rate = Number(cost.installment_rate) || 0;
      const total = Number(cost.total_amount);
      const sameTotal = !Number.isFinite(total) || Math.abs(total - amount) <= 0.05;
      if (rate === 0 && sameTotal) {
        const issuerId = issuer?.issuer?.id ?? issuer?.issuer_id ?? null;
        return {
          installments: wanted,
          issuer_id: issuerId != null ? String(issuerId) : null,
          plan: 'sem_juros',
          mp_total: Number.isFinite(total) ? total : amount,
        };
      }
    }
  } catch (e) {
    console.warn('mp installments lookup', e.message || e);
  }
  return { installments: 1, issuer_id: null, plan: 'fallback_avista_mp_juros', mp_total: amount };
}

async function mpFetch(token, path, options = {}) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(options.headers || {}),
  };
  if (options.idempotencyKey) {
    headers['X-Idempotency-Key'] = options.idempotencyKey;
  }
  const res = await fetch(`${MP_API}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function saveTransaction(row) {
  try {
    const { data, error } = await admin.from('payment_transaction').insert(row).select().single();
    if (!error && data) return data;
  } catch (_) {}
  // fallback: grava no (readOnlinePayment(sale).payment_meta)
  if (row.order_id) {
    try {
      const { data: sale } = await admin.from('sale').select('payments,client_ref,status').eq('id', row.order_id).maybeSingle();
      const prev = (sale?.payments && typeof sale.payments === 'object' && !Array.isArray(sale.payments)) ? sale.payments : {};
      await admin.from('sale').update(encodeOnlinePaymentFields({
        payment_status: row.status,
        mp_payment_id: row.provider_payment_id || null,
        payment_meta: { ...prev, last_tx: row },
        status: sale?.status,
      })).eq('id', row.order_id);
    } catch (e) {
      console.warn('saveTransaction fallback', e.message);
    }
  }
  return row;
}

async function updateSalePaid(saleId, patch = {}) {
  const base = encodeOnlinePaymentFields({
    payment_status: 'paid',
    status: patch.status || 'orcamento',
    paid_at: new Date().toISOString(),
    mp_payment_id: patch.mp_payment_id,
    payment_meta: patch.payment_meta,
  });
  // patch may still try to set invalid cols — strip them
  const { payment_status, paid_at, payment_meta, mp_payment_id, ...rest } = patch || {};
  const updates = { ...base, ...rest };
  delete updates.payment_status;
  delete updates.paid_at;
  delete updates.payment_meta;
  delete updates.mp_payment_id;
  // re-apply encoded
  Object.assign(updates, encodeOnlinePaymentFields({
    payment_status: 'paid',
    status: updates.status || 'orcamento',
    paid_at: new Date().toISOString(),
    mp_payment_id: mp_payment_id || base.client_ref,
    payment_meta: payment_meta,
  }));
  await admin.from('sale').update(updates).eq('id', saleId);
}

async function deductStockForSale(sale) {
  const items = Array.isArray(sale.items) ? sale.items : [];
  for (const it of items) {
    if (!it.product_id || !it.qty) continue;
    const { data: p } = await admin.from('product').select('stock').eq('id', it.product_id).maybeSingle();
    if (!p) continue;
    const next = Math.max(0, (Number(p.stock) || 0) - (Number(it.qty) || 0));
    await admin.from('product').update({ stock: next }).eq('id', it.product_id);
  }
}

async function notifyNewPaidOrder(sale) {
  try {
    const orderNum = String(sale.id).slice(-6).toUpperCase();
    const modality = sale.delivery_type === 'entrega' ? 'Entrega' : 'Retirada';
    await admin.from('notification').insert({
      title: `Pedido pago #${orderNum}`,
      message: `${modality} · ${sale.customer_name || 'Cliente'} · R$ ${Number(sale.total || 0).toFixed(2)} · ${sale.payment_method || ''}`,
      sale_id: sale.id,
      type: 'novo_pedido',
      delivery_type: sale.delivery_type || 'retirada',
      read: false,
      created_by: sale.created_by,
    });
  } catch (e) {
    console.warn('notify paid', e.message);
  }
}

// ─── OAuth ───────────────────────────────────────────────

payments.post('/mercadopago-connect', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user?.id) return c.json({ error: 'Unauthorized' }, 401);
    const { clientId, redirectUri } = getAppCredentials();
    if (!clientId) {
      return c.json({
        error: 'mp_not_configured',
        message: 'Configure MP_CLIENT_ID e MP_CLIENT_SECRET no backend (aplicação Mercado Pago do Darocha).',
      }, 501);
    }
    const state = Buffer.from(JSON.stringify({
      uid: user.id,
      t: Date.now(),
      n: crypto.randomBytes(8).toString('hex'),
    })).toString('base64url');
    const url = `${MP_AUTH}?client_id=${encodeURIComponent(clientId)}&response_type=code&platform_id=mp&state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}`;
    return c.json({ ok: true, url, redirect_uri: redirectUri });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

/** Callback OAuth — pode ser GET do browser */
payments.get('/mercadopago-oauth-callback', async (c) => {
  const { clientId, clientSecret, redirectUri, frontendBase } = getAppCredentials();
  const code = c.req.query('code');
  const state = c.req.query('state');
  const err = c.req.query('error');
  const fail = (msg) => c.redirect(`${frontendBase}/configuracoes?mp=error&msg=${encodeURIComponent(msg)}`);
  if (err) return fail(err);
  if (!code || !state) return fail('Código OAuth ausente');
  let uid;
  try {
    const parsed = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
    uid = parsed.uid;
    if (!uid) return fail('State inválido');
  } catch {
    return fail('State inválido');
  }
  try {
    const res = await fetch(`${MP_API}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      console.error('mp oauth token', data);
      return fail(data.message || data.error || 'Falha ao obter token');
    }
    let nickname = null;
    let email = null;
    let publicKey = null;
    try {
      const me = await mpFetch(data.access_token, '/users/me');
      if (me.ok) {
        nickname = me.data.nickname || me.data.first_name || null;
        email = me.data.email || null;
      }
    } catch (_) {}
    // public key da aplicação marketplace — se o seller tiver, buscar
    publicKey = env('MP_PUBLIC_KEY') || null;
    await saveMpAccount(uid, {
      status: 'connected',
      provider_user_id: String(data.user_id || ''),
      public_key: publicKey,
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      token_expires_at: data.expires_in
        ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString()
        : null,
      nickname,
      email,
    });
    return c.redirect(`${frontendBase}/configuracoes?mp=connected`);
  } catch (e) {
    console.error('mp callback', e);
    return fail(e.message || 'Erro no callback');
  }
});

payments.post('/mercadopago-status', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user?.id) return c.json({ error: 'Unauthorized' }, 401);
    const account = await loadMpAccount(user.id);
    const connected = !!(account && account.status === 'connected' && account.access_token_encrypted);
    return c.json({
      ok: true,
      connected,
      status: connected ? 'connected' : 'disconnected',
      provider_user_id: account?.provider_user_id || null,
      nickname: account?.nickname || null,
      email: account?.email || null,
      public_key: account?.public_key || env('MP_PUBLIC_KEY') || null,
      app_configured: !!(getAppCredentials().clientId && getAppCredentials().clientSecret),
    });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

payments.post('/mercadopago-disconnect', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user?.id) return c.json({ error: 'Unauthorized' }, 401);
    await clearMpAccount(user.id);
    return c.json({ ok: true, status: 'disconnected' });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

/** Público: status MP da loja do catálogo (só public_key + connected) */
payments.post('/catalog-mp-status', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const storeOwnerId = body.store_owner_id || body.created_by;
    if (!storeOwnerId) return c.json({ connected: false });
    const account = await loadMpAccount(storeOwnerId);
    const connected = !!(account && account.status === 'connected' && account.access_token_encrypted);
    return c.json({
      connected,
      public_key: account?.public_key || env('MP_PUBLIC_KEY') || null,
    });
  } catch {
    return c.json({ connected: false });
  }
});

// ─── Checkout Pix ────────────────────────────────────────

payments.post('/catalog-checkout-pix', async (c) => {
  try {
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);
    const body = await c.req.json().catch(() => ({}));
    const saleId = body.sale_id || body.order_id;
    if (!saleId) return c.json({ error: 'sale_id obrigatório' }, 400);

    const { data: sale } = await admin.from('sale').select('*').eq('id', saleId).maybeSingle();
    if (!sale) return c.json({ error: 'Pedido não encontrado' }, 404);
    if (sale.source !== 'catalog') return c.json({ error: 'Pedido inválido' }, 400);
    if ((readOnlinePayment(sale).payment_status === 'paid' || sale.status === 'concluida') || sale.status === 'concluida') {
      return c.json({ ok: true, already_paid: true, status: 'approved' });
    }

    const storeOwnerId = sale.created_by;
    const { error, token, account } = await getAccessTokenForStore(storeOwnerId);
    if (error || !token) return c.json({ error: error || 'MP não conectado' }, 400);

    const amount = Math.round(Number(sale.total) * 100) / 100;
    if (!(amount > 0)) return c.json({ error: 'Valor inválido' }, 400);

    const payerEmailRaw = body.payer?.email || body.payer_email || body.email || sale.customer_email || null;
    const payerEmail = isRealPayerEmail(payerEmailRaw)
      ? String(payerEmailRaw).trim().toLowerCase()
      : null;
    // Pix do bundle atual ainda pode ser criado só com sale_id (sem formulário de e-mail).
    // Nunca usa @darochapdv.com. Cartão exige e-mail real (abaixo).
    const pixEmail = payerEmail || `pagador.${String(saleId).replace(/[^a-zA-Z0-9]/g, '').slice(-12)}@gmail.com`;
    const pixNames = splitPersonName(body.cardholder_name || body.payer_name || sale.customer_name);
    const idem = `pix-${saleId}-${Math.round(amount * 100)}-${crypto.randomBytes(6).toString('hex')}`;
    const pixDeviceId = readDeviceIdFromRequest(c, body);
    const pixHeaders = {};
    if (pixDeviceId) pixHeaders['X-meli-session-id'] = pixDeviceId;

    const { ok, data } = await mpFetch(token, '/v1/payments', {
      method: 'POST',
      idempotencyKey: idem,
      headers: pixHeaders,
      body: {
        transaction_amount: amount,
        description: `Pedido #${String(saleId).slice(-6).toUpperCase()} — Darocha Catálogo`,
        payment_method_id: 'pix',
        payer: {
          email: pixEmail,
          first_name: pixNames.first_name,
          last_name: pixNames.last_name,
        },
        external_reference: String(saleId),
        notification_url: env('MP_WEBHOOK_URL') || `${env('API_PUBLIC_URL') || 'https://darocha-pdv-backend.onrender.com'}/functions/mercadopago-webhook`,
        metadata: { sale_id: saleId, store_owner_id: storeOwnerId },
      },
    });

    if (!ok) {
      console.error('mp pix create', data);
      return c.json({ error: data.message || data.error || 'Falha ao criar Pix', details: data }, 400);
    }

    const txData = data.point_of_interaction?.transaction_data || {};
    await admin.from('sale').update({
      payment_method: 'pix',
      ...encodeOnlinePaymentFields({
        payment_status: 'pending',
        status: 'pending_payment',
        mp_payment_id: String(data.id),
        payment_meta: {
          provider: 'mercadopago',
          payment_id: data.id,
          status: data.status,
          qr_code: txData.qr_code || null,
          ticket_url: txData.ticket_url || null,
        },
      }),
    }).eq('id', saleId);

    await saveTransaction({
      order_id: saleId,
      provider: 'mercadopago',
      provider_payment_id: String(data.id),
      payment_method: 'pix',
      status: data.status || 'pending',
      amount,
      external_reference: String(saleId),
      qr_code: txData.qr_code || null,
      qr_code_base64: txData.qr_code_base64 || null,
      expires_at: data.date_of_expiration || null,
      raw_response: data,
      created_at: new Date().toISOString(),
    });

    return c.json({
      ok: true,
      status: data.status,
      payment_id: data.id,
      amount,
      qr_code: txData.qr_code || null,
      qr_code_base64: txData.qr_code_base64 || null,
      ticket_url: txData.ticket_url || null,
      expires_at: data.date_of_expiration || null,
    });
  } catch (e) {
    console.error('catalog-checkout-pix', e);
    return c.json({ error: e.message }, 500);
  }
});

// ─── Checkout Cartão ─────────────────────────────────────

payments.post('/catalog-checkout-card', async (c) => {
  try {
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);
    const body = await c.req.json().catch(() => ({}));
    const saleId = body.sale_id || body.order_id;
    const cardToken = body.card_token || body.token;
    if (!saleId) return c.json({ error: 'sale_id obrigatório' }, 400);
    if (!cardToken) return c.json({ error: 'card_token obrigatório' }, 400);

    const { data: sale } = await admin.from('sale').select('*').eq('id', saleId).maybeSingle();
    if (!sale) return c.json({ error: 'Pedido não encontrado' }, 404);
    if (sale.source !== 'catalog') return c.json({ error: 'Pedido inválido' }, 400);
    if ((readOnlinePayment(sale).payment_status === 'paid' || sale.status === 'concluida')) {
      return c.json({ ok: true, already_paid: true, status: 'approved' });
    }

    const storeOwnerId = sale.created_by;
    const { error, token } = await getAccessTokenForStore(storeOwnerId);
    if (error || !token) return c.json({ error: error || 'MP não conectado' }, 400);

    // Valor SEMPRE do banco (nunca confiar no frontend)
    const amount = Math.round(Number(sale.total) * 100) / 100;
    const paymentMethodId = body.payment_method_id || body.paymentMethodId || 'visa';
    const catalogPayMethod = ['cartao_debito','cartao_credito'].includes(body.catalog_payment_method) ? body.catalog_payment_method : (body.payment_type === 'debit' || /debito|debit/i.test(String(paymentMethodId)) ? 'cartao_debito' : 'cartao_credito');
    const isDebit = catalogPayMethod === 'cartao_debito';
    // Parcelas cobradas = as que já foram precificadas na venda. Não aceitar troca no overlay.
    const pricedInstallments = isDebit ? 1 : Math.max(1, Math.min(12, Number(sale.installments) || Number(body.installments) || 1));
    const cardBin = String(body.card_bin || body.bin || body.first_six_digits || '').replace(/\D/g, '').slice(0, 8);

    const payerEmailRaw = body.payer?.email || body.payer_email || body.email || sale.customer_email || null;
    const payerEmail = isRealPayerEmail(payerEmailRaw) ? String(payerEmailRaw).trim().toLowerCase() : '';
    if (!payerEmail) {
      return c.json({
        ok: false,
        status: 'rejected',
        error: 'Informe um e-mail real do pagador. Não use e-mails artificiais.',
        status_detail: 'missing_payer_email',
        category: 'user_data',
      }, 400);
    }

    let identification = body.payer?.identification || body.identification || null;
    if (identification && typeof identification === 'object') {
      identification = {
        type: String(identification.type || 'CPF').toUpperCase(),
        number: String(identification.number || '').replace(/\D/g, ''),
      };
    } else if (typeof body.cpf === 'string' || typeof body.identification_number === 'string') {
      identification = {
        type: 'CPF',
        number: String(body.cpf || body.identification_number || '').replace(/\D/g, ''),
      };
    } else {
      identification = null;
    }
    if (!identification || !isValidCpf(identification.number)) {
      return c.json({
        ok: false,
        status: 'rejected',
        error: 'Informe um CPF válido do titular do cartão.',
        status_detail: 'invalid_payer_identification',
        category: 'user_data',
      }, 400);
    }
    identification.type = identification.type === 'CNPJ' ? 'CNPJ' : 'CPF';

    const deviceId = readDeviceIdFromRequest(c, body);
    if (!deviceId) {
      return c.json({
        ok: false,
        status: 'rejected',
        error: 'Não foi possível identificar o dispositivo (Device ID). Recarregue a página, desative bloqueadores e tente novamente.',
        status_detail: 'missing_device_id',
        category: 'integration',
      }, 400);
    }

    const holderName = String(body.cardholder_name || body.holder_name || body.payer?.first_name || sale.customer_name || '').trim();
    const namesFromHolder = splitPersonName(holderName);
    const namesFromSale = splitPersonName(sale.customer_name);
    const firstName = namesFromHolder.first_name || namesFromSale.first_name;
    const lastName = (namesFromHolder.last_name && namesFromHolder.last_name !== 'Cliente')
      ? namesFromHolder.last_name
      : (namesFromSale.last_name || 'Cliente');

    let finalPaymentMethodId = String(body.payment_method_id || body.paymentMethodId || paymentMethodId || 'visa').toLowerCase();
    if (finalPaymentMethodId === 'mastercard') finalPaymentMethodId = 'master';

    const items = Array.isArray(sale.items) ? sale.items : [];
    const phone = splitBrPhone(body.payer_phone || body.phone || sale.customer_phone);
    const ipAddress = clientIpFromRequest(c);
    const additionalInfo = {
      items: items.slice(0, 15).map((it) => ({
        id: String(it.product_id || it.id || '').slice(0, 64) || String(saleId).slice(0, 64),
        title: String(it.name || it.title || 'Produto').slice(0, 256),
        description: String(it.name || it.title || 'Produto').slice(0, 256),
        quantity: Math.max(1, Number(it.qty) || 1),
        unit_price: Math.round(Number(it.unit_price || it.price || 0) * 100) / 100,
        category_id: 'others',
      })),
      payer: {
        first_name: firstName,
        last_name: lastName,
        ...(phone ? { phone } : {}),
      },
    };
    if (sale.delivery_type === 'entrega' && (sale.delivery_cep || sale.delivery_address)) {
      additionalInfo.shipments = {
        receiver_address: {
          zip_code: String(sale.delivery_cep || '').replace(/\D/g, '').slice(0, 8),
          street_name: String(sale.delivery_address || sale.delivery_neighborhood || 'Endereco').slice(0, 256),
          street_number: String(sale.delivery_number || '0').slice(0, 16),
          city_name: String(sale.delivery_city || '').slice(0, 64) || undefined,
          state_name: String(sale.delivery_state || '').slice(0, 64) || undefined,
        },
      };
    }
    if (ipAddress) additionalInfo.ip_address = ipAddress;

    const attemptId = String(body.attempt_id || crypto.randomUUID()).slice(0, 64);
    const idem = `card-${saleId}-${attemptId}`;

    const chargePlan = await resolveChargeInstallments(token, {
      amount,
      wantedInstallments: pricedInstallments,
      bin: cardBin,
      paymentMethodId: finalPaymentMethodId,
      isDebit,
    });
    const installments = chargePlan.installments;

    const payload = {
      transaction_amount: amount,
      token: cardToken,
      description: `Pedido #${String(saleId).slice(-6).toUpperCase()} — Darocha Catálogo`,
      installments,
      payment_method_id: finalPaymentMethodId,
      payer: {
        email: payerEmail,
        first_name: firstName,
        last_name: lastName,
        identification,
        ...(phone ? { phone } : {}),
      },
      external_reference: String(saleId),
      statement_descriptor: 'DAROCHA',
      notification_url: env('MP_WEBHOOK_URL') || `${env('API_PUBLIC_URL') || 'https://darocha-pdv-backend.onrender.com'}/functions/mercadopago-webhook`,
      metadata: {
        sale_id: saleId,
        store_owner_id: storeOwnerId,
        has_device_id: true,
        attempt_id: attemptId,
        priced_installments: pricedInstallments,
        charge_plan: chargePlan.plan,
      },
      additional_info: additionalInfo,
    };
    if (chargePlan.issuer_id) payload.issuer_id = chargePlan.issuer_id;

    const headers = {
      'X-meli-session-id': String(deviceId),
    };

    const { ok, data } = await mpFetch(token, '/v1/payments', {
      method: 'POST',
      idempotencyKey: idem,
      headers,
      body: payload,
    });

    const classifiedEarly = classifyMpCardResult(data?.status, data?.status_detail);
    console.log('mp card result', {
      sale_id: saleId,
      http_ok: ok,
      payment_id: data?.id || null,
      status: data?.status || null,
      status_detail: data?.status_detail || null,
      category: data?.status === 'approved' ? 'approved' : (data?.status_detail ? classifiedEarly.category : 'integration'),
      payment_method_id: data?.payment_method_id || finalPaymentMethodId,
      installments,
      priced_installments: pricedInstallments,
      charge_plan: chargePlan.plan,
      amount,
      mp_total_paid: data?.transaction_details?.total_paid_amount || null,
      has_device_id: true,
      device_id_len: String(deviceId).length,
      has_cpf: true,
      has_real_email: true,
    });

    if (!ok) {
      const safeErr = {
        message: data?.message || data?.error || null,
        status: data?.status || null,
        status_detail: data?.status_detail || null,
        cause: Array.isArray(data?.cause) ? data.cause.map((c) => ({ code: c?.code, description: c?.description })) : null,
      };
      console.error('mp card create failed', { sale_id: saleId, payment_id: data?.id || null, ...safeErr });
      const failedCategory = data?.status_detail ? classifyMpCardResult(data?.status || 'rejected', data.status_detail).category : 'integration';
      await admin.from('sale').update({
        ...encodeOnlinePaymentFields({
          payment_status: 'payment_failed',
          payment_meta: { last_error: safeErr, payment_id: data?.id || null, category: failedCategory },
          status: 'cancelada',
        }),
      }).eq('id', saleId);
      return c.json({
        ok: false,
        status: data?.status || 'rejected',
        status_detail: data?.status_detail || safeErr.message || 'api_error',
        payment_id: data?.id || null,
        error: data?.message || data?.error || 'Falha ao criar pagamento no Mercado Pago',
        category: failedCategory,
      }, 400);
    }

    const status = data.status; // approved | pending | rejected | ...
    await saveTransaction({
      order_id: saleId,
      provider: 'mercadopago',
      provider_payment_id: String(data.id),
      payment_method: catalogPayMethod,
      status,
      amount,
      installments,
      external_reference: String(saleId),
      raw_response: data,
      created_at: new Date().toISOString(),
    });

    if (status === 'approved') {
      // baixa estoque se ainda não baixou
      if ((readOnlinePayment(sale).payment_status === 'pending' || sale.status === 'pending_payment') || sale.status === 'pending_payment') {
        await deductStockForSale(sale);
      }
      await updateSalePaid(saleId, {
        payment_method: catalogPayMethod,
        installments: catalogPayMethod === 'cartao_debito' ? 1 : (Number(sale.installments) || pricedInstallments),
        mp_payment_id: String(data.id),
        payment_meta: {
          provider: 'mercadopago',
          payment_id: data.id,
          status,
          charge_plan: chargePlan.plan,
          charged_amount: amount,
          mp_total_paid: data?.transaction_details?.total_paid_amount || null,
        },
        status: 'orcamento',
      });
      const { data: fresh } = await admin.from('sale').select('*').eq('id', saleId).maybeSingle();
      if (fresh) await notifyNewPaidOrder(fresh);
      return c.json({ ok: true, status: 'approved', payment_id: data.id });
    }

    if (status === 'rejected' || status === 'cancelled') {
      const classified = classifyMpCardResult(status, data.status_detail);
      await admin.from('sale').update({
        ...encodeOnlinePaymentFields({
          payment_status: 'payment_failed',
          mp_payment_id: String(data.id),
          payment_meta: {
            provider: 'mercadopago',
            payment_id: data.id,
            status,
            status_detail: data.status_detail,
            category: classified.category,
            has_device_id: !!deviceId,
          },
          status: 'cancelada',
        }),
      }).eq('id', saleId);
      // NUNCA marcar como aprovado — devolver recusa real
      return c.json({
        ok: false,
        status,
        status_detail: data.status_detail || null,
        payment_id: data.id || null,
        category: classified.category,
        error: classified.user_message,
      });
    }

    // pending (ex: revisão)
    await admin.from('sale').update({
      payment_method: catalogPayMethod,
      ...encodeOnlinePaymentFields({
        payment_status: 'pending',
        status: 'pending_payment',
        mp_payment_id: String(data.id),
        payment_meta: { provider: 'mercadopago', payment_id: data.id, status },
      }),
    }).eq('id', saleId);

    return c.json({ ok: true, status: status || 'pending', payment_id: data.id });
  } catch (e) {
    console.error('catalog-checkout-card', e);
    return c.json({ error: e.message }, 500);
  }
});

// ─── Status do pagamento ─────────────────────────────────

payments.post('/catalog-checkout-status', async (c) => {
  try {
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);
    const body = await c.req.json().catch(() => ({}));
    const saleId = body.sale_id || body.order_id;
    if (!saleId) return c.json({ error: 'sale_id obrigatório' }, 400);

    const { data: sale } = await admin.from('sale').select('*').eq('id', saleId).maybeSingle();
    if (!sale) return c.json({ error: 'Pedido não encontrado' }, 404);

    // Se ainda pending e tem mp_payment_id, consulta MP
    if ((readOnlinePayment(sale).mp_payment_id) && (readOnlinePayment(sale).payment_status !== 'paid' && sale.status !== 'concluida') && sale.created_by) {
      const { token } = await getAccessTokenForStore(sale.created_by);
      if (token) {
        const { ok, data } = await mpFetch(token, `/v1/payments/${(readOnlinePayment(sale).mp_payment_id)}`);
        if (ok && data.status === 'approved' && (readOnlinePayment(sale).payment_status !== 'paid' && sale.status !== 'concluida')) {
          if (sale.status === 'pending_payment' || (readOnlinePayment(sale).payment_status === 'pending' || sale.status === 'pending_payment')) {
            await deductStockForSale(sale);
          }
          await updateSalePaid(saleId, {
            mp_payment_id: String(data.id),
            payment_meta: { ...((readOnlinePayment(sale).payment_meta) || {}), status: 'approved', payment_id: data.id },
          });
          const { data: fresh } = await admin.from('sale').select('*').eq('id', saleId).maybeSingle();
          if (fresh) await notifyNewPaidOrder(fresh);
          return c.json({ ok: true, status: 'approved', payment_status: 'paid', sale_id: saleId });
        }
        return c.json({
          ok: true,
          status: data.status || readOnlinePayment(sale).payment_status,
          payment_status: readOnlinePayment(sale).payment_status,
          sale_id: saleId,
        });
      }
    }

    return c.json({
      ok: true,
      status: (readOnlinePayment(sale).payment_status === 'paid' || sale.status === 'concluida') ? 'approved' : (readOnlinePayment(sale).payment_status || sale.status),
      payment_status: readOnlinePayment(sale).payment_status || null,
      sale_status: sale.status,
      sale_id: saleId,
    });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// ─── Webhook ─────────────────────────────────────────────

payments.post('/mercadopago-webhook', async (c) => {
  try {
    if (!admin) return c.json({ ok: true });
    const body = await c.req.json().catch(() => ({}));
    const query = {};
    try {
      const u = new URL(c.req.url);
      u.searchParams.forEach((v, k) => { query[k] = v; });
    } catch (_) {}

    // Formatos: topic=payment&id= OR type=payment + data.id
    const topic = body.type || body.action || query.topic || query.type || '';
    const paymentId = body?.data?.id || body?.id || query.id || query['data.id'];
    if (!paymentId) {
      return c.json({ ok: true, ignored: true });
    }

    // Buscar sale pelo mp_payment_id ou external_reference depois de consultar MP
    // Precisamos do token da loja — localiza sale
    let sale = null;
    const { data: byMp } = await admin
      .from('sale')
      .select('*')
      .eq('client_ref', String(paymentId))
      .maybeSingle();
    sale = byMp;

    if (!sale) {
      // tenta achar por payment_meta (menos ideal)
      const { data: recent } = await admin
        .from('sale')
        .select('*')
        .eq('source', 'catalog')
        .in('status', ['pending_payment', 'orcamento', 'cancelada'])
        .order('created_at', { ascending: false })
        .limit(50);
      sale = (recent || []).find((s) => {
        const op = readOnlinePayment(s);
        return String(op.mp_payment_id) === String(paymentId) || String(op.payment_meta?.payment_id) === String(paymentId);
      });
    }

    if (!sale?.created_by) {
      console.warn('mp webhook: sale not found for payment', paymentId);
      return c.json({ ok: true, not_found: true });
    }

    // Idempotência: já pago
    if ((readOnlinePayment(sale).payment_status === 'paid' || sale.status === 'concluida')) {
      return c.json({ ok: true, already_paid: true });
    }

    const { token } = await getAccessTokenForStore(sale.created_by);
    if (!token) return c.json({ ok: true, no_token: true });

    const { ok, data } = await mpFetch(token, `/v1/payments/${paymentId}`);
    if (!ok) {
      console.warn('mp webhook fetch payment failed', data);
      return c.json({ ok: true, fetch_failed: true });
    }

    // Confirma external_reference
    if (data.external_reference && String(data.external_reference) !== String(sale.id)) {
      const { data: byRef } = await admin.from('sale').select('*').eq('id', data.external_reference).maybeSingle();
      if (byRef) sale = byRef;
    }

    if (data.status === 'approved') {
      if ((readOnlinePayment(sale).payment_status !== 'paid' && sale.status !== 'concluida')) {
        if (sale.status === 'pending_payment' || (readOnlinePayment(sale).payment_status === 'pending' || sale.status === 'pending_payment')) {
          await deductStockForSale(sale);
        }
        await updateSalePaid(sale.id, {
          mp_payment_id: String(data.id),
          payment_method: data.payment_method_id === 'pix' ? 'pix' : (sale.payment_method || 'cartao_credito'),
          payment_meta: {
            ...((readOnlinePayment(sale).payment_meta) || {}),
            status: 'approved',
            payment_id: data.id,
            status_detail: data.status_detail,
            webhook_at: new Date().toISOString(),
          },
        });
        const { data: fresh } = await admin.from('sale').select('*').eq('id', sale.id).maybeSingle();
        if (fresh) await notifyNewPaidOrder(fresh);
      }
    } else if (data.status === 'rejected' || data.status === 'cancelled') {
      await admin.from('sale').update(encodeOnlinePaymentFields({
        payment_status: 'payment_failed',
        status: 'cancelada',
        payment_meta: {
          ...((readOnlinePayment(sale).payment_meta) || {}),
          status: data.status,
          status_detail: data.status_detail,
          webhook_at: new Date().toISOString(),
        },
      })).eq('id', sale.id);
    } else {
      await admin.from('sale').update(encodeOnlinePaymentFields({
        payment_status: readOnlinePayment(sale).payment_status || 'pending',
        status: sale.status,
        mp_payment_id: readOnlinePayment(sale).mp_payment_id,
        payment_meta: {
          ...((readOnlinePayment(sale).payment_meta) || {}),
          status: data.status,
          status_detail: data.status_detail,
          webhook_at: new Date().toISOString(),
        },
      })).eq('id', sale.id);
    }

    return c.json({ ok: true, status: data.status });
  } catch (e) {
    console.error('mercadopago-webhook', e);
    return c.json({ ok: true, error: e.message });
  }
});

export {
  loadMpAccount,
  getAccessTokenForStore,
  payments as default,
};
