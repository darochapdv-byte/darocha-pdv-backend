/**
 * Stone / Pagar.me Connect — PDV + maquininha.
 * Auth oficial: Basic (secret_key:) em https://api.pagar.me/core/v5
 * Pedido POS: POST /orders  closed:false + poi_payment_settings
 * Split: payments[].split com recipient_id (PSP marketplace). Só enviado se
 * DAROCHA_PAGARME_RECIPIENT_ID e a conta da loja tiverem split habilitado.
 */
import { Hono } from 'hono';
import crypto from 'crypto';
import { admin } from './db.js';
import { requireUser } from './helpers.js';
import { recordSaleCommission, commissionRate, calcCommissionCents, toCents, fromCents } from './commission.js';

const stone = new Hono();
const STONE_API = 'https://api.pagar.me/core/v5';

function env(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}

function encryptionKey() {
  const raw = env('STONE_TOKEN_ENCRYPTION_KEY') || env('MP_TOKEN_ENCRYPTION_KEY') || env('JWT_SECRET') || 'darocha-stone-key';
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

async function saveStoneAccount(storeId, acc) {
  const payload = {
    provider: 'stone',
    status: acc.status || 'connected',
    access_token_encrypted: acc.secret_encrypted || null,
    public_key: acc.terminal_serial || null,
    provider_user_id: acc.recipient_id || null,
    nickname: 'stone',
    connected_at: new Date().toISOString(),
  };
  try {
    const { data: existing } = await admin.from('payment_account').select('id').eq('user_id', storeId).eq('provider', 'stone').maybeSingle();
    if (existing?.id) {
      await admin.from('payment_account').update({ ...payload, updated_at: new Date().toISOString() }).eq('id', existing.id);
    } else {
      await admin.from('payment_account').insert({ user_id: storeId, ...payload });
    }
  } catch (e) {
    console.warn('payment_account stone', e.message);
  }
  const { data: rows } = await admin.from('app_settings').select('id,role_payment_methods').eq('created_by', storeId).order('created_at', { ascending: false }).limit(1);
  const row = rows?.[0];
  const current = (row?.role_payment_methods && typeof row.role_payment_methods === 'object' && !Array.isArray(row.role_payment_methods))
    ? { ...row.role_payment_methods } : {};
  current.__darocha_stone = {
    status: acc.status,
    secret_encrypted: acc.secret_encrypted,
    recipient_id: acc.recipient_id || null,
    terminal_serial: acc.terminal_serial || null,
    last_error: acc.last_error || null,
  };
  if (row?.id) await admin.from('app_settings').update({ role_payment_methods: current }).eq('id', row.id);
  else await admin.from('app_settings').insert({ created_by: storeId, role_payment_methods: current });
}

async function loadStoneAccount(storeId) {
  if (!admin || !storeId) return null;
  try {
    const { data } = await admin.from('stone_account').select('*').eq('store_id', storeId).maybeSingle();
    if (data?.secret_encrypted) return data;
  } catch (_) {}
  try {
    const { data } = await admin.from('payment_account').select('*').eq('user_id', storeId).eq('provider', 'stone').maybeSingle();
    if (data?.access_token_encrypted) {
      return {
        store_id: storeId,
        secret_encrypted: data.access_token_encrypted,
        terminal_serial: data.public_key || null,
        recipient_id: data.provider_user_id || null,
        status: data.status || 'connected',
      };
    }
  } catch (_) {}
  const { data: rows } = await admin.from('app_settings').select('role_payment_methods').eq('created_by', storeId).order('created_at', { ascending: false }).limit(1);
  const st = rows?.[0]?.role_payment_methods?.__darocha_stone;
  if (st?.secret_encrypted) {
    return {
      store_id: storeId,
      secret_encrypted: st.secret_encrypted,
      terminal_serial: st.terminal_serial || null,
      recipient_id: st.recipient_id || null,
      status: st.status || 'connected',
      last_error: st.last_error || null,
    };
  }
  return null;
}

async function stoneFetch(secretKey, path, { method = 'GET', body } = {}) {
  const auth = Buffer.from(`${secretKey}:`).toString('base64');
  const res = await fetch(`${STONE_API}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      ServiceRefererName: env('STONE_SERVICE_REFERER') || 'DarochaPDV',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function splitRules(amountCents) {
  const platformRecipient = env('DAROCHA_PAGARME_RECIPIENT_ID');
  const merchantRecipient = env('STONE_DEFAULT_MERCHANT_RECIPIENT') || '';
  if (!platformRecipient) return null;
  const fee = Math.round(amountCents * commissionRate());
  const rest = amountCents - fee;
  if (fee <= 0 || rest <= 0) return null;
  const rules = [
    { amount: fee, recipient_id: platformRecipient, type: 'flat', options: { liable: false, charge_processing_fee: false } },
  ];
  if (merchantRecipient) {
    rules.push({ amount: rest, recipient_id: merchantRecipient, type: 'flat', options: { liable: true, charge_processing_fee: true } });
  }
  return rules;
}

stone.post('/stone-connect', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user?.id) return c.json({ error: 'Unauthorized' }, 401);
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);
    const body = await c.req.json().catch(() => ({}));
    const secret = String(body.secret_key || body.api_key || '').trim();
    if (!secret) {
      return c.json({
        error: 'secret_key_required',
        message: 'Cole a Secret Key da operação Stone/Pagar.me (sk_...). Fica só no servidor.',
        docs: 'https://docs.pagar.me/',
        connect_pos: 'https://connect-stone.stone.com.br/reference/criar-pedido',
      }, 400);
    }
    const test = await stoneFetch(secret, '/recipients?page=1&size=1');
    const row = {
      store_id: user.id,
      secret_encrypted: encrypt(secret),
      recipient_id: body.recipient_id || null,
      terminal_serial: body.terminal_serial || body.device_id || null,
      status: test.ok || test.status === 200 ? 'connected' : 'pending_credentials',
      last_error: test.ok ? null : (test.data?.message || JSON.stringify(test.data).slice(0, 240)),
      updated_at: new Date().toISOString(),
    };
    try {
      const { data: existing } = await admin.from('stone_account').select('id').eq('store_id', user.id).maybeSingle();
      if (existing?.id) await admin.from('stone_account').update(row).eq('id', existing.id);
      else await admin.from('stone_account').insert({ ...row, created_at: new Date().toISOString() });
    } catch (_) {}
    await saveStoneAccount(user.id, row);
    return c.json({
      ok: true,
      status: row.status,
      split_ready: !!env('DAROCHA_PAGARME_RECIPIENT_ID'),
      note: env('DAROCHA_PAGARME_RECIPIENT_ID')
        ? 'Split 1% será enviado quando o pedido POS aceitar o objeto split.'
        : 'Conta ligada. Para o 1% cair na hora, cadastre DAROCHA_PAGARME_RECIPIENT_ID (recebedor Darocha no Pagar.me PSP) e habilite split na operação.',
    });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

stone.post('/stone-status', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user?.id) return c.json({ error: 'Unauthorized' }, 401);
    const acc = await loadStoneAccount(user.id);
    return c.json({
      ok: true,
      connected: !!(acc && acc.status === 'connected'),
      status: acc?.status || 'disconnected',
      terminal_serial: acc?.terminal_serial || null,
      recipient_id: acc?.recipient_id || null,
      split_ready: !!env('DAROCHA_PAGARME_RECIPIENT_ID'),
      commission_rate: commissionRate(),
    });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

stone.post('/stone-disconnect', async (c) => {
  const user = await requireUser(c);
  if (!user?.id) return c.json({ error: 'Unauthorized' }, 401);
  if (admin) {
    try { await admin.from('stone_account').delete().eq('store_id', user.id); } catch (_) {}
    try { await admin.from('payment_account').delete().eq('user_id', user.id).eq('provider', 'stone'); } catch (_) {}
    const { data: rows } = await admin.from('app_settings').select('id,role_payment_methods').eq('created_by', user.id).limit(1);
    const row = rows?.[0];
    if (row?.id && row.role_payment_methods && typeof row.role_payment_methods === 'object') {
      const next = { ...row.role_payment_methods };
      delete next.__darocha_stone;
      await admin.from('app_settings').update({ role_payment_methods: next }).eq('id', row.id);
    }
  }
  return c.json({ ok: true });
});

stone.post('/stone-devices', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user?.id) return c.json({ error: 'Unauthorized' }, 401);
    const acc = await loadStoneAccount(user.id);
    if (!acc?.secret_encrypted) return c.json({ error: 'stone_not_connected' }, 400);
    const secret = decrypt(acc.secret_encrypted);
    const { ok, data } = await stoneFetch(secret, '/terminals?page=1&size=20');
    return c.json({ ok: !!ok, devices: data?.data || data?.terminals || data || [], raw_ok: ok });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

stone.post('/stone-charge', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user?.id) return c.json({ error: 'Unauthorized' }, 401);
    const body = await c.req.json().catch(() => ({}));
    const acc = await loadStoneAccount(user.id);
    if (!acc?.secret_encrypted) return c.json({ error: 'stone_not_connected' }, 400);
    const secret = decrypt(acc.secret_encrypted);
    const amount = Math.round(Number(body.amount || 0) * 100);
    if (!(amount > 0)) return c.json({ error: 'Valor inválido' }, 400);
    const serial = body.terminal_serial || acc.terminal_serial;
    const split = splitRules(amount);
    const payload = {
      closed: false,
      code: String(body.external_reference || body.sale_id || Date.now()).slice(0, 52),
      customer: {
        name: body.customer_name || 'Consumidor final',
        type: 'individual',
        document: String(body.document || '00000000000').replace(/\D/g, '').slice(0, 14) || '00000000000',
      },
      items: [{
        amount,
        description: body.description || 'Venda PDV Darocha',
        quantity: 1,
        code: 'pdv',
      }],
      poi_payment_settings: {
        visible: true,
        print_order_receipt: true,
        devices_serial_number: serial ? [serial] : undefined,
        payment_setup: {
          type: /pix/i.test(String(body.payment_type || '')) ? 'pix' : 'credit',
          installments: Number(body.installments) || 1,
        },
      },
    };
    if (split && acc.split_enabled !== false) {
      payload.payments = [{
        payment_method: 'checkout',
        amount,
        split,
      }];
    }
    const { ok, data, status } = await stoneFetch(secret, '/orders', { method: 'POST', body: payload });
    if (!ok) {
      return c.json({
        error: data?.message || data?.errors?.[0]?.message || 'Falha ao enviar para a maquininha Stone',
        details: data,
        split_attempted: !!split,
      }, status >= 400 ? status : 400);
    }
    return c.json({
      ok: true,
      order_id: data.id,
      status: data.status,
      split_applied: !!(split && ok),
      fee_reais: fromCents(calcCommissionCents(amount / 100)),
    });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

stone.post('/stone-order-status', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user?.id) return c.json({ error: 'Unauthorized' }, 401);
    const body = await c.req.json().catch(() => ({}));
    const acc = await loadStoneAccount(user.id);
    if (!acc?.secret_encrypted) return c.json({ error: 'stone_not_connected' }, 400);
    const secret = decrypt(acc.secret_encrypted);
    const id = body.order_id;
    if (!id) return c.json({ error: 'order_id obrigatório' }, 400);
    const { ok, data } = await stoneFetch(secret, `/orders/${id}`);
    const paid = String(data?.status || '').toLowerCase() === 'paid';
    if (paid && body.sale_id && admin) {
      const { data: sale } = await admin.from('sale').select('*').eq('id', body.sale_id).maybeSingle();
      if (sale) {
        await recordSaleCommission({
          sale,
          provider: 'stone',
          origin: 'pdv',
          externalId: id,
          status: env('DAROCHA_PAGARME_RECIPIENT_ID') ? 'received' : 'due',
          splitApplied: !!env('DAROCHA_PAGARME_RECIPIENT_ID'),
        });
      }
    }
    return c.json({ ok, status: data?.status, paid, order: data });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

stone.post('/stone-webhook', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const type = body.type || body.event || '';
    const order = body.data || body.order || body;
    const orderId = order.id || order.order?.id;
    const status = String(order.status || '').toLowerCase();
    if (orderId && admin && (status === 'paid' || type.includes('paid'))) {
      const { data: sale } = await admin.from('sale').select('*').eq('client_ref', String(orderId)).maybeSingle();
      if (sale) {
        await recordSaleCommission({
          sale,
          provider: 'stone',
          origin: sale.source || 'pdv',
          externalId: orderId,
          status: env('DAROCHA_PAGARME_RECIPIENT_ID') ? 'received' : 'due',
          splitApplied: !!env('DAROCHA_PAGARME_RECIPIENT_ID'),
        });
      }
    }
    if ((status === 'canceled' || status === 'failed' || String(type).includes('refund')) && orderId && admin) {
      const { reverseCommission } = await import('./commission.js');
      const { data: sale } = await admin.from('sale').select('id').eq('client_ref', String(orderId)).maybeSingle();
      if (sale) await reverseCommission({ saleId: sale.id, provider: 'stone', totalRefund: true });
    }
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ ok: true, warning: e.message });
  }
});

export default stone;
export { loadStoneAccount };
