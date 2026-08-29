/**
 * Mercado Pago — multi-lojista (OAuth + Pix + Cartão + Webhook)
 * Cada loja conecta a própria conta e recebe diretamente.
 */
import { Hono } from 'hono';
import crypto from 'crypto';
import { admin } from './db.js';
import { requireUser } from './helpers.js';

const payments = new Hono();

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
  const { data: rows } = await admin
    .from('app_settings')
    .select('id,mercadopago')
    .eq('created_by', userId)
    .order('created_at', { ascending: false })
    .limit(1);
  const row = rows?.[0];
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
  if (row?.id) {
    const { error } = await admin.from('app_settings').update({ mercadopago: payload }).eq('id', row.id);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await admin.from('app_settings').insert({ created_by: userId, mercadopago: payload });
    if (error) throw new Error(error.message);
  }
  // tabela opcional payment_account
  try {
    await admin.from('payment_account').upsert({
      user_id: userId,
      provider: 'mercadopago',
      provider_user_id: payload.provider_user_id,
      access_token_encrypted: payload.access_token_encrypted,
      refresh_token_encrypted: payload.refresh_token_encrypted,
      public_key: payload.public_key,
      token_expires_at: payload.token_expires_at,
      status: payload.status,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,provider' });
  } catch (_) { /* tabela pode não existir */ }
  return payload;
}

async function loadMpAccount(userId) {
  if (!userId) return null;
  // tenta payment_account
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
    .select('mercadopago')
    .eq('created_by', userId)
    .order('created_at', { ascending: false })
    .limit(5);
  for (const r of rows || []) {
    if (r?.mercadopago?.access_token_encrypted || r?.mercadopago?.status === 'connected') {
      return r.mercadopago;
    }
  }
  return null;
}

async function clearMpAccount(userId) {
  const { data: rows } = await admin
    .from('app_settings')
    .select('id,mercadopago')
    .eq('created_by', userId)
    .limit(10);
  for (const r of rows || []) {
    if (r.mercadopago) {
      await admin.from('app_settings').update({ mercadopago: { status: 'disconnected' } }).eq('id', r.id);
    }
  }
  try {
    await admin.from('payment_account').delete().eq('user_id', userId).eq('provider', 'mercadopago');
  } catch (_) {}
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
  // fallback: grava no sale.payment_meta
  if (row.order_id) {
    try {
      const { data: sale } = await admin.from('sale').select('payment_meta').eq('id', row.order_id).maybeSingle();
      const meta = { ...(sale?.payment_meta || {}), last_tx: row };
      await admin.from('sale').update({
        payment_meta: meta,
        mp_payment_id: row.provider_payment_id || null,
        payment_status: row.status,
      }).eq('id', row.order_id);
    } catch (e) {
      console.warn('saveTransaction fallback', e.message);
    }
  }
  return row;
}

async function updateSalePaid(saleId, patch = {}) {
  const updates = {
    payment_status: 'paid',
    status: 'orcamento',
    paid_at: new Date().toISOString(),
    ...patch,
  };
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
    if (sale.payment_status === 'paid' || sale.status === 'concluida') {
      return c.json({ ok: true, already_paid: true, status: 'approved' });
    }

    const storeOwnerId = sale.created_by;
    const { error, token, account } = await getAccessTokenForStore(storeOwnerId);
    if (error || !token) return c.json({ error: error || 'MP não conectado' }, 400);

    const amount = Math.round(Number(sale.total) * 100) / 100;
    if (!(amount > 0)) return c.json({ error: 'Valor inválido' }, 400);

    const payerEmail = body.payer_email || sale.customer_email || `cliente+${String(sale.id).slice(-8)}@darochapdv.com`;
    const idem = `pix-${saleId}-${Math.round(amount * 100)}`;

    const { ok, data } = await mpFetch(token, '/v1/payments', {
      method: 'POST',
      idempotencyKey: idem,
      body: {
        transaction_amount: amount,
        description: `Pedido #${String(saleId).slice(-6).toUpperCase()} — Darocha Catálogo`,
        payment_method_id: 'pix',
        payer: {
          email: payerEmail,
          first_name: (sale.customer_name || 'Cliente').split(' ')[0],
          last_name: (sale.customer_name || '').split(' ').slice(1).join(' ') || 'Cliente',
        },
        external_reference: String(saleId),
        notification_url: env('MP_WEBHOOK_URL') || `${env('API_PUBLIC_URL') || 'https://api.darochapdv.com'}/functions/mercadopago-webhook`,
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
    if (sale.payment_status === 'paid') {
      return c.json({ ok: true, already_paid: true, status: 'approved' });
    }

    const storeOwnerId = sale.created_by;
    const { error, token } = await getAccessTokenForStore(storeOwnerId);
    if (error || !token) return c.json({ error: error || 'MP não conectado' }, 400);

    // Valor SEMPRE do banco (nunca confiar no frontend)
    const amount = Math.round(Number(sale.total) * 100) / 100;
    const installments = Math.max(1, Math.min(12, Number(body.installments) || Number(sale.installments) || 1));
    const paymentMethodId = body.payment_method_id || body.paymentMethodId || 'visa';
    const catalogPayMethod = ['cartao_debito','cartao_credito'].includes(body.catalog_payment_method) ? body.catalog_payment_method : (body.payment_type === 'debit' || /debito|debit/i.test(String(paymentMethodId)) ? 'cartao_debito' : 'cartao_credito');
    const payerEmail = body.payer?.email || body.payer_email || sale.customer_email || `cliente+${String(sale.id).slice(-8)}@darochapdv.com`;
    const identification = body.payer?.identification || body.identification || null;

    const idem = `card-${saleId}-${Math.round(amount * 100)}-${installments}-${String(cardToken).slice(-8)}`;

    const payload = {
      transaction_amount: amount,
      token: cardToken,
      description: `Pedido #${String(saleId).slice(-6).toUpperCase()} — Darocha Catálogo`,
      installments,
      payment_method_id: paymentMethodId,
      payer: {
        email: payerEmail,
        ...(identification ? { identification } : {}),
      },
      external_reference: String(saleId),
      notification_url: env('MP_WEBHOOK_URL') || `${env('API_PUBLIC_URL') || 'https://api.darochapdv.com'}/functions/mercadopago-webhook`,
      metadata: { sale_id: saleId, store_owner_id: storeOwnerId },
    };

    const { ok, data } = await mpFetch(token, '/v1/payments', {
      method: 'POST',
      idempotencyKey: idem,
      body: payload,
    });

    if (!ok) {
      console.error('mp card create', data);
      await admin.from('sale').update({
        payment_status: 'payment_failed',
        payment_meta: { last_error: data },
      }).eq('id', saleId);
      return c.json({
        ok: false,
        status: 'rejected',
        error: data.message || data.error || 'Pagamento recusado',
        details: data,
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
      if (sale.payment_status === 'pending' || sale.status === 'pending_payment') {
        await deductStockForSale(sale);
      }
      await updateSalePaid(saleId, {
        payment_method: catalogPayMethod,
        installments: catalogPayMethod === 'cartao_debito' ? 1 : installments,
        mp_payment_id: String(data.id),
        payment_meta: { provider: 'mercadopago', payment_id: data.id, status },
      });
      const { data: fresh } = await admin.from('sale').select('*').eq('id', saleId).maybeSingle();
      if (fresh) await notifyNewPaidOrder(fresh);
      return c.json({ ok: true, status: 'approved', payment_id: data.id });
    }

    if (status === 'rejected' || status === 'cancelled') {
      await admin.from('sale').update({
        payment_status: 'payment_failed',
        mp_payment_id: String(data.id),
        payment_meta: { provider: 'mercadopago', payment_id: data.id, status, status_detail: data.status_detail },
      }).eq('id', saleId);
      return c.json({ ok: false, status, status_detail: data.status_detail, payment_id: data.id });
    }

    // pending (ex: revisão)
    await admin.from('sale').update({
      payment_status: 'pending',
      status: 'pending_payment',
      payment_method: catalogPayMethod,
      mp_payment_id: String(data.id),
      payment_meta: { provider: 'mercadopago', payment_id: data.id, status },
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
    if (sale.mp_payment_id && sale.payment_status !== 'paid' && sale.created_by) {
      const { token } = await getAccessTokenForStore(sale.created_by);
      if (token) {
        const { ok, data } = await mpFetch(token, `/v1/payments/${sale.mp_payment_id}`);
        if (ok && data.status === 'approved' && sale.payment_status !== 'paid') {
          if (sale.status === 'pending_payment' || sale.payment_status === 'pending') {
            await deductStockForSale(sale);
          }
          await updateSalePaid(saleId, {
            mp_payment_id: String(data.id),
            payment_meta: { ...(sale.payment_meta || {}), status: 'approved', payment_id: data.id },
          });
          const { data: fresh } = await admin.from('sale').select('*').eq('id', saleId).maybeSingle();
          if (fresh) await notifyNewPaidOrder(fresh);
          return c.json({ ok: true, status: 'approved', payment_status: 'paid', sale_id: saleId });
        }
        return c.json({
          ok: true,
          status: data.status || sale.payment_status,
          payment_status: sale.payment_status,
          sale_id: saleId,
        });
      }
    }

    return c.json({
      ok: true,
      status: sale.payment_status === 'paid' ? 'approved' : (sale.payment_status || sale.status),
      payment_status: sale.payment_status || null,
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
      .eq('mp_payment_id', String(paymentId))
      .maybeSingle();
    sale = byMp;

    if (!sale) {
      // tenta achar por payment_meta (menos ideal)
      const { data: recent } = await admin
        .from('sale')
        .select('*')
        .eq('source', 'catalog')
        .in('payment_status', ['pending', 'payment_failed'])
        .order('created_at', { ascending: false })
        .limit(50);
      sale = (recent || []).find((s) => String(s.mp_payment_id) === String(paymentId) || String(s.payment_meta?.payment_id) === String(paymentId));
    }

    if (!sale?.created_by) {
      console.warn('mp webhook: sale not found for payment', paymentId);
      return c.json({ ok: true, not_found: true });
    }

    // Idempotência: já pago
    if (sale.payment_status === 'paid') {
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
      if (sale.payment_status !== 'paid') {
        if (sale.status === 'pending_payment' || sale.payment_status === 'pending') {
          await deductStockForSale(sale);
        }
        await updateSalePaid(sale.id, {
          mp_payment_id: String(data.id),
          payment_method: data.payment_method_id === 'pix' ? 'pix' : (sale.payment_method || 'cartao_credito'),
          payment_meta: {
            ...(sale.payment_meta || {}),
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
      await admin.from('sale').update({
        payment_status: 'payment_failed',
        payment_meta: {
          ...(sale.payment_meta || {}),
          status: data.status,
          status_detail: data.status_detail,
          webhook_at: new Date().toISOString(),
        },
      }).eq('id', sale.id);
    } else {
      await admin.from('sale').update({
        payment_meta: {
          ...(sale.payment_meta || {}),
          status: data.status,
          status_detail: data.status_detail,
          webhook_at: new Date().toISOString(),
        },
      }).eq('id', sale.id);
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
