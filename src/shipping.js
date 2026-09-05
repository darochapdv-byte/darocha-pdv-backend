/**
 * Frete Darocha — Melhor Envio (OAuth por loja).
 * Docs: https://docs.melhorenvio.com.br
 * Cotação: POST /api/v2/me/shipment/calculate
 */
import { Hono } from 'hono';
import crypto from 'crypto';
import { admin } from './db.js';
import { requireUser, resolveStoreBySlug } from './helpers.js';

const shipping = new Hono();

function env(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}

function meBase() {
  return env('ME_SANDBOX') === '1'
    ? 'https://sandbox.melhorenvio.com.br'
    : 'https://melhorenvio.com.br';
}

function encryptionKey() {
  const raw = env('ME_TOKEN_ENCRYPTION_KEY') || env('MP_TOKEN_ENCRYPTION_KEY') || env('JWT_SECRET') || 'darocha-me-key';
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
  if (!str.startsWith('v1:')) return str;
  const [, ivB, tagB, dataB] = str.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB, 'base64')), decipher.final()]).toString('utf8');
}

function onlyDigits(v, n = 8) {
  return String(v || '').replace(/\D/g, '').slice(0, n);
}

async function loadShipCfg(storeId) {
  if (!admin || !storeId) return {};
  const { data: rows } = await admin
    .from('app_settings')
    .select('id,role_payment_methods')
    .eq('created_by', storeId)
    .order('created_at', { ascending: false })
    .limit(1);
  const blob = rows?.[0]?.role_payment_methods;
  const cfg = (blob && typeof blob === 'object' && blob.__darocha_me) || {};
  return { ...cfg, _rowId: rows?.[0]?.id, _all: (blob && typeof blob === 'object') ? blob : {} };
}

async function saveShipCfg(storeId, patch) {
  const cur = await loadShipCfg(storeId);
  const nextMe = { ...cur, ...patch };
  delete nextMe._rowId;
  delete nextMe._all;
  const all = { ...(cur._all || {}), __darocha_me: nextMe };
  if (cur._rowId) {
    await admin.from('app_settings').update({ role_payment_methods: all }).eq('id', cur._rowId);
  } else {
    await admin.from('app_settings').insert({ created_by: storeId, role_payment_methods: all });
  }
  return nextMe;
}

async function meFetch(token, path, { method = 'GET', body } = {}) {
  const res = await fetch(`${meBase()}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'DarochaPDV (contato@darochapdv.com)',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function refreshIfNeeded(storeId, cfg) {
  if (!cfg?.access_token_encrypted) return cfg;
  const exp = Date.parse(cfg.token_expires_at || 0);
  if (exp && Date.now() < exp - 60 * 60 * 1000) return cfg;
  const refresh = cfg.refresh_token_encrypted ? decrypt(cfg.refresh_token_encrypted) : '';
  if (!refresh || !env('ME_CLIENT_ID') || !env('ME_CLIENT_SECRET')) return cfg;
  const res = await fetch(`${meBase()}/oauth/token`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'DarochaPDV (contato@darochapdv.com)' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: env('ME_CLIENT_ID'),
      client_secret: env('ME_CLIENT_SECRET'),
      refresh_token: refresh,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    await saveShipCfg(storeId, { status: 'token_expired', last_error: 'Token Melhor Envio expirado. Reconecte.' });
    return { ...cfg, status: 'token_expired' };
  }
  const next = {
    status: 'connected',
    access_token_encrypted: encrypt(data.access_token),
    refresh_token_encrypted: data.refresh_token ? encrypt(data.refresh_token) : cfg.refresh_token_encrypted,
    token_expires_at: new Date(Date.now() + (Number(data.expires_in) || 2592000) * 1000).toISOString(),
    last_error: null,
  };
  await saveShipCfg(storeId, next);
  return { ...cfg, ...next };
}

function publicCfg(cfg) {
  return {
    connected: cfg.status === 'connected' && !!cfg.access_token_encrypted,
    status: cfg.status || 'disconnected',
    origin_cep: cfg.origin_cep || '',
    origin_street: cfg.origin_street || '',
    origin_number: cfg.origin_number || '',
    origin_complement: cfg.origin_complement || '',
    origin_district: cfg.origin_district || '',
    origin_city: cfg.origin_city || '',
    origin_state: cfg.origin_state || '',
    enabled_services: cfg.enabled_services || null,
    free_over: Number(cfg.free_over || 0) || 0,
    surcharge: Number(cfg.surcharge || 0) || 0,
    discount: Number(cfg.discount || 0) || 0,
    pack_weight_g: Number(cfg.pack_weight_g || 300) || 300,
    pack_h: Number(cfg.pack_h || 8) || 8,
    pack_w: Number(cfg.pack_w || 16) || 16,
    pack_l: Number(cfg.pack_l || 16) || 16,
    last_error: cfg.status === 'connected' ? null : (cfg.last_error || null),
    app_configured: !!(env('ME_CLIENT_ID') && env('ME_CLIENT_SECRET') && env('ME_REDIRECT_URI')),
  };
}

function applyStoreRules(options, cfg, cartTotal) {
  const extra = Number(cfg.surcharge || 0) || 0;
  const disc = Number(cfg.discount || 0) || 0;
  const freeOver = Number(cfg.free_over || 0) || 0;
  const enabled = Array.isArray(cfg.enabled_services) && cfg.enabled_services.length
    ? new Set(cfg.enabled_services.map(String))
    : null;
  return options
    .filter((o) => !enabled || enabled.has(String(o.service_id)))
    .map((o) => {
      let price = Math.max(0, Number(o.price_raw) + extra - disc);
      if (freeOver > 0 && Number(cartTotal) >= freeOver) price = 0;
      return { ...o, price: Math.round(price * 100) / 100, free: price === 0 && Number(o.price_raw) > 0 };
    });
}

function packItems(items, cfg) {
  const dw = (Number(cfg.pack_weight_g) || 300) / 1000;
  const dh = Number(cfg.pack_h) || 8;
  const dwd = Number(cfg.pack_w) || 16;
  const dl = Number(cfg.pack_l) || 16;
  return (items || []).map((it, i) => {
    const qty = Math.max(1, Number(it.qty || it.quantity) || 1);
    const wKg = Number(it.weight_kg);
    const wG = Number(it.weight_g);
    const weight = Number.isFinite(wKg) && wKg > 0 ? wKg : (Number.isFinite(wG) && wG > 0 ? wG / 1000 : dw);
    return {
      id: String(it.product_id || it.id || i + 1),
      width: Math.max(1, Number(it.width || it.largura) || dwd),
      height: Math.max(1, Number(it.height || it.altura) || dh),
      length: Math.max(1, Number(it.length || it.comprimento) || dl),
      weight: Math.max(0.05, weight),
      insurance_value: Math.max(0, Number(it.unit_price || it.sale_price || it.price) || 0),
      quantity: qty,
    };
  });
}

shipping.post('/melhorenvio-status', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user?.id) return c.json({ error: 'Unauthorized' }, 401);
    const cfg = await loadShipCfg(user.id);
    return c.json({ ok: true, ...publicCfg(cfg) });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

shipping.post('/melhorenvio-save-origin', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user?.id) return c.json({ error: 'Unauthorized' }, 401);
    const b = await c.req.json().catch(() => ({}));
    const cep = onlyDigits(b.origin_cep || b.cep);
    if (cep && cep.length !== 8) return c.json({ error: 'CEP de origem inválido' }, 400);
    const saved = await saveShipCfg(user.id, {
      origin_cep: cep,
      origin_street: b.origin_street || b.street || '',
      origin_number: b.origin_number || b.number || '',
      origin_complement: b.origin_complement || b.complement || '',
      origin_district: b.origin_district || b.district || b.neighborhood || '',
      origin_city: b.origin_city || b.city || '',
      origin_state: String(b.origin_state || b.state || '').toUpperCase().slice(0, 2),
      enabled_services: Array.isArray(b.enabled_services) ? b.enabled_services.map(String) : undefined,
      free_over: b.free_over != null ? Number(b.free_over) || 0 : undefined,
      surcharge: b.surcharge != null ? Number(b.surcharge) || 0 : undefined,
      discount: b.discount != null ? Number(b.discount) || 0 : undefined,
      pack_weight_g: b.pack_weight_g != null ? Number(b.pack_weight_g) || 300 : undefined,
      pack_h: b.pack_h != null ? Number(b.pack_h) || 8 : undefined,
      pack_w: b.pack_w != null ? Number(b.pack_w) || 16 : undefined,
      pack_l: b.pack_l != null ? Number(b.pack_l) || 16 : undefined,
    });
    return c.json({ ok: true, ...publicCfg(saved) });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

shipping.post('/melhorenvio-connect', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user?.id) return c.json({ error: 'Unauthorized' }, 401);
    const clientId = env('ME_CLIENT_ID');
    const redirect = env('ME_REDIRECT_URI');
    if (!clientId || !redirect) {
      return c.json({
        error: 'app_not_configured',
        message: 'Crie o aplicativo Darocha no Melhor Envio e configure ME_CLIENT_ID, ME_CLIENT_SECRET e ME_REDIRECT_URI no Render.',
      }, 400);
    }
    const state = Buffer.from(JSON.stringify({ u: user.id, t: Date.now() })).toString('base64url');
    const scope = [
      'shipping-calculate', 'shipping-companies', 'shipping-preview',
      'shipping-checkout', 'shipping-generate', 'shipping-print', 'shipping-tracking',
      'cart-read', 'cart-write', 'users-read',
    ].join(' ');
    const authorize = `${meBase()}/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&state=${encodeURIComponent(state)}&scope=${encodeURIComponent(scope)}&prompt=login`;
    const url = `${meBase()}/login?redirect=${encodeURIComponent(authorize)}`;
    return c.json({ ok: true, url, authorize, force_login: true });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

shipping.get('/melhorenvio-oauth-callback', async (c) => {
  const code = c.req.query('code');
  const stateRaw = c.req.query('state');
  const front = env('FRONTEND_URL') || 'https://darochapdv.com';
  const fail = (msg) => c.redirect(`${front}/configuracoes?me=erro&msg=${encodeURIComponent(msg)}`);
  if (!code) return fail('Autorização cancelada');
  let storeId = '';
  try {
    storeId = JSON.parse(Buffer.from(String(stateRaw || ''), 'base64url').toString('utf8')).u;
  } catch {
    return fail('Estado inválido');
  }
  const res = await fetch(`${meBase()}/oauth/token`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'DarochaPDV (contato@darochapdv.com)' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: env('ME_CLIENT_ID'),
      client_secret: env('ME_CLIENT_SECRET'),
      redirect_uri: env('ME_REDIRECT_URI'),
      code,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) return fail(data.message || 'Falha ao obter token');
  await saveShipCfg(storeId, {
    status: 'connected',
    access_token_encrypted: encrypt(data.access_token),
    refresh_token_encrypted: data.refresh_token ? encrypt(data.refresh_token) : '',
    token_expires_at: new Date(Date.now() + (Number(data.expires_in) || 2592000) * 1000).toISOString(),
    connected_at: new Date().toISOString(),
    last_error: null,
  });
  return c.redirect(`${front}/configuracoes?me=ok`);
});

shipping.post('/melhorenvio-disconnect', async (c) => {
  const user = await requireUser(c);
  if (!user?.id) return c.json({ error: 'Unauthorized' }, 401);
  await saveShipCfg(user.id, {
    status: 'disconnected',
    access_token_encrypted: '',
    refresh_token_encrypted: '',
    token_expires_at: null,
    last_error: null,
  });
  return c.json({ ok: true });
});

shipping.post('/shipping-calculate', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const toCep = onlyDigits(body.cep || body.to_cep);
    if (toCep.length !== 8 || toCep === '00000000') {
      return c.json({ error: 'CEP inválido', message: 'Informe o CEP de destino do cliente para calcular o frete.' }, 200);
    }
    let storeId = body.store_id || body.owner_id || '';
    const slug = String(body.slug || body.loja || '').trim();
    if (!storeId && slug) {
      const resolved = await resolveStoreBySlug(slug);
      if (resolved?.userId) storeId = resolved.userId;
    }
    if (!storeId) {
      const ref = c.req.header('Referer') || c.req.header('Referrer') || '';
      const m = ref.match(/[?&]loja=([a-zA-Z0-9-]+)/) || ref.match(/\/catalogo\/([a-zA-Z0-9-]+)/);
      if (m) {
        const resolved = await resolveStoreBySlug(m[1]);
        if (resolved?.userId) storeId = resolved.userId;
      }
    }
    if (!storeId) {
      try {
        const user = await requireUser(c);
        if (user?.id) storeId = user.id;
      } catch (_) {}
    }
    if (!storeId) {
      return c.json({
        error: 'store_missing',
        message: 'Não identifiquei a loja para calcular o frete. Abra o catálogo pelo link da loja.',
      }, 200);
    }

    const neighborhood = String(body.neighborhood || body.bairro || '').trim();
    const forceMe = String(body.shipping_mode || body.delivery_mode || '').toLowerCase() === 'melhor_envio';
    if (neighborhood && !forceMe) {
      const { data: fees } = await admin
        .from('delivery_fee')
        .select('id,fee,neighborhood')
        .eq('created_by', storeId)
        .eq('active', true)
        .ilike('neighborhood', neighborhood)
        .limit(1);
      if (fees?.[0]) {
        return c.json({
          ok: true,
          use_store_fee: true,
          options: [],
          store_fee: Number(fees[0].fee) || 0,
          message: 'Este bairro já tem taxa da loja. O Melhor Envio não é usado neste caso.',
        });
      }
    }

    let cfg = await loadShipCfg(storeId);
    cfg = await refreshIfNeeded(storeId, cfg);
    const fromCep = onlyDigits(cfg.origin_cep);
    if (fromCep.length !== 8) {
      return c.json({ error: 'origin_missing', message: 'A loja ainda não configurou o CEP de origem da entrega.', options: [] }, 200);
    }
    if (cfg.status !== 'connected' || !cfg.access_token_encrypted) {
      return c.json({ error: 'not_connected', message: 'A loja ainda não conectou o Melhor Envio.', options: [] }, 200);
    }

    let products = packItems(body.items || [], cfg);
    if (!products.length) {
      products = packItems([{ qty: 1, unit_price: Number(body.cart_total) || 0 }], cfg);
    }

    const token = decrypt(cfg.access_token_encrypted);
    const { ok, data } = await meFetch(token, '/api/v2/me/shipment/calculate', {
      method: 'POST',
      body: { from: { postal_code: fromCep }, to: { postal_code: toCep }, products },
    });
    if (!ok) {
      const apiMsg = data && (data.message || data.error || data.errors);
      return c.json({
        error: 'quote_failed',
        message: 'Não foi possível calcular o frete para este CEP. Verifique o CEP e tente novamente.',
        options: [],
      }, 200);
    }
    const raw = Array.isArray(data) ? data : [];
    const options = raw
      .filter((s) => s && !s.error && Number(s.custom_price || s.price || 0) > 0)
      .map((s) => ({
        service_id: String(s.id),
        company: s.company?.name || s.company || '',
        name: s.name || '',
        price_raw: Number(s.custom_price || s.price || 0),
        days: Number(s.custom_delivery_time || s.delivery_time || 0),
        currency: 'BRL',
      }));
    const priced = applyStoreRules(options, cfg, body.cart_total);
    return c.json({
      ok: true,
      from_cep: fromCep,
      to_cep: toCep,
      options: priced.map((o) => ({
        service_id: o.service_id,
        company: o.company,
        name: o.name,
        price: o.price,
        days: o.days,
        label: `${o.company ? o.company + ' ' : ''}${o.name}`.trim(),
        deadline: o.days ? `${o.days} dia${o.days === 1 ? '' : 's'} úteis` : '',
        free: o.free,
      })),
    });
  } catch (e) {
    return c.json({
      error: 'quote_failed',
      message: 'Não foi possível calcular o frete para este CEP. Verifique o CEP e tente novamente.',
    }, 200);
  }
});

export default shipping;
export { loadShipCfg, publicCfg };
