/**
 * Comissão Darocha — cálculo central (backend).
 * Percentual: DAROCHA_COMMISSION_RATE (padrão 0.01 = 1%).
 * Mensalidade Stripe permanece independente.
 */
import { admin } from './db.js';

export function commissionRate() {
  const n = Number(process.env.DAROCHA_COMMISSION_RATE);
  if (Number.isFinite(n) && n >= 0 && n < 1) return n;
  return 0.01;
}

export function toCents(reais) {
  return Math.round(Number(reais || 0) * 100);
}

export function fromCents(cents) {
  return Math.round(Number(cents || 0)) / 100;
}

export function calcCommissionCents(grossReais) {
  const cents = toCents(grossReais);
  if (cents <= 0) return 0;
  return Math.round(cents * commissionRate());
}

export function isElectronicMethod(method) {
  const m = String(method || '').toLowerCase();
  if (!m) return false;
  if (m.includes('dinheiro') || m.includes('vale') || m.includes('cortesia') || m === 'cash') return false;
  return /pix|cartao|cartão|credito|crédito|debito|débito|credit|debit|point|stone|mp|mercadopago|online/.test(m);
}

function packNote(payload) {
  return `DAROCHA_FEE ${JSON.stringify(payload)}`;
}

function unpackNote(description) {
  const raw = String(description || '');
  const i = raw.indexOf('{');
  if (i < 0) return null;
  try { return JSON.parse(raw.slice(i)); } catch { return null; }
}

export async function upsertCommission(row) {
  if (!admin || !row?.sale_id || !row?.store_id) return null;
  const payload = {
    store_id: row.store_id,
    sale_id: row.sale_id,
    provider: row.provider || 'unknown',
    origin: row.origin || 'unknown',
    payment_method: row.payment_method || '',
    external_id: row.external_id ? String(row.external_id) : null,
    gross_cents: Number(row.gross_cents || 0),
    rate: commissionRate(),
    fee_cents: Number(row.fee_cents || 0),
    merchant_cents: Number(row.merchant_cents || 0),
    status: row.status || 'pending',
    split_applied: !!row.split_applied,
    split_error: row.split_error || null,
    refunded_cents: Number(row.refunded_cents || 0),
    meta: row.meta || {},
    updated_at: new Date().toISOString(),
  };

  try {
    const { data: existing, error } = await admin
      .from('platform_commission')
      .select('id,status')
      .eq('sale_id', row.sale_id)
      .eq('provider', payload.provider)
      .limit(1);
    if (!error) {
      if (existing && existing[0]) {
        if (existing[0].status === 'received' && payload.status === 'pending') return existing[0];
        const { data } = await admin.from('platform_commission').update(payload).eq('id', existing[0].id).select().maybeSingle();
        return data || existing[0];
      }
      const { data } = await admin.from('platform_commission').insert({ ...payload, created_at: new Date().toISOString() }).select().maybeSingle();
      if (data) return data;
    }
  } catch (e) {
    console.warn('platform_commission unavailable', e.message);
  }

  try {
    const { data: logs } = await admin
      .from('operational_log')
      .select('id,description')
      .eq('sale_id', row.sale_id)
      .eq('type', 'darocha_commission')
      .eq('created_by', row.store_id)
      .limit(8);
    const match = (logs || []).find((l) => {
      const p = unpackNote(l.description);
      return p && p.provider === payload.provider;
    });
    const desc = packNote(payload);
    if (match) {
      await admin.from('operational_log').update({ description: desc }).eq('id', match.id);
      return { id: match.id, ...payload };
    }
    const { data } = await admin.from('operational_log').insert({
      type: 'darocha_commission',
      level: 'info',
      description: desc,
      created_by: row.store_id,
      sale_id: row.sale_id,
      client_ref: payload.external_id,
    }).select().maybeSingle();
    return data ? { id: data.id, ...payload } : payload;
  } catch (e) {
    console.warn('commission log fallback', e.message);
    return payload;
  }
}

export async function listCommissions(storeId, limit = 500) {
  if (!admin || !storeId) return [];
  try {
    const { data, error } = await admin
      .from('platform_commission')
      .select('*')
      .eq('store_id', storeId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (!error && Array.isArray(data) && data.length) return data;
  } catch (_) {}
  try {
    const { data } = await admin
      .from('operational_log')
      .select('*')
      .eq('created_by', storeId)
      .eq('type', 'darocha_commission')
      .order('created_at', { ascending: false })
      .limit(limit);
    return (data || []).map((l) => {
      const p = unpackNote(l.description) || {};
      return { id: l.id, created_at: l.created_at, ...p };
    });
  } catch (_) {
    return [];
  }
}

export async function recordSaleCommission({
  sale,
  provider,
  origin,
  externalId,
  status,
  splitApplied,
  splitError,
  extraMeta,
} = {}) {
  if (!sale?.id) return null;
  const method = sale.payment_method;
  if (!isElectronicMethod(method)) return null;
  const st = String(sale.status || '').toLowerCase();
  if (st.includes('cancel') || st === 'orcamento') return null;
  const grossCents = toCents(sale.total);
  const feeCents = calcCommissionCents(sale.total);
  const received = status === 'received' || splitApplied === true;
  return upsertCommission({
    store_id: sale.created_by,
    sale_id: sale.id,
    provider,
    origin: origin || sale.source || 'pdv',
    payment_method: method,
    external_id: externalId,
    gross_cents: grossCents,
    fee_cents: feeCents,
    merchant_cents: Math.max(0, grossCents - feeCents),
    status: received ? 'received' : (status || 'due'),
    split_applied: !!splitApplied,
    split_error: splitError || null,
    meta: extraMeta || {},
  });
}

export async function reverseCommission({ saleId, provider, refundedReais, totalRefund, storeId } = {}) {
  if (!admin || !saleId) return null;
  const refundGuess = totalRefund ? null : calcCommissionCents(refundedReais);
  try {
    let q = admin.from('platform_commission').select('*').eq('sale_id', saleId);
    if (provider) q = q.eq('provider', provider);
    const { data: rows, error } = await q.limit(5);
    if (!error && rows && rows[0]) {
      const row = rows[0];
      const refundCents = totalRefund ? row.fee_cents : refundGuess;
      const nextFee = Math.max(0, Number(row.fee_cents || 0) - refundCents);
      const status = nextFee <= 0 ? 'refunded' : 'partial_refund';
      const { data } = await admin.from('platform_commission').update({
        fee_cents: nextFee,
        refunded_cents: Number(row.refunded_cents || 0) + refundCents,
        status,
        updated_at: new Date().toISOString(),
      }).eq('id', row.id).select().maybeSingle();
      return data;
    }
  } catch (_) {}
  try {
    let q = admin.from('operational_log').select('*').eq('sale_id', saleId).eq('type', 'darocha_commission');
    if (storeId) q = q.eq('created_by', storeId);
    const { data: logs } = await q.limit(8);
    const rowLog = (logs || []).find((l) => {
      const p = unpackNote(l.description);
      return p && (!provider || p.provider === provider);
    });
    if (!rowLog) return null;
    const p = unpackNote(rowLog.description) || {};
    const refundCents = totalRefund ? Number(p.fee_cents || 0) : refundGuess;
    p.refunded_cents = Number(p.refunded_cents || 0) + Number(refundCents || 0);
    p.fee_cents = Math.max(0, Number(p.fee_cents || 0) - Number(refundCents || 0));
    p.status = p.fee_cents <= 0 ? 'refunded' : 'partial_refund';
    p.updated_at = new Date().toISOString();
    await admin.from('operational_log').update({ description: packNote(p) }).eq('id', rowLog.id);
    return p;
  } catch (e) {
    console.warn('commission reverse', e.message);
    return null;
  }
}

export function applicationFeeReais(grossReais) {
  return fromCents(calcCommissionCents(grossReais));
}
