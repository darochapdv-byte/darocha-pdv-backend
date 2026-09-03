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
    const { data: existing } = await admin
      .from('platform_commission')
      .select('id,status')
      .eq('sale_id', row.sale_id)
      .eq('provider', payload.provider)
      .limit(1);
    if (existing && existing[0]) {
      if (existing[0].status === 'received' && payload.status === 'pending') return existing[0];
      const { data } = await admin.from('platform_commission').update(payload).eq('id', existing[0].id).select().maybeSingle();
      return data || existing[0];
    }
    const insert = { ...payload, created_at: new Date().toISOString() };
    const { data, error } = await admin.from('platform_commission').insert(insert).select().maybeSingle();
    if (error) {
      console.warn('commission insert', error.message);
      return null;
    }
    return data;
  } catch (e) {
    console.warn('commission upsert', e.message);
    return null;
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

export async function reverseCommission({ saleId, provider, refundedReais, totalRefund } = {}) {
  if (!admin || !saleId) return null;
  try {
    let q = admin.from('platform_commission').select('*').eq('sale_id', saleId);
    if (provider) q = q.eq('provider', provider);
    const { data: rows } = await q.limit(5);
    const row = (rows || [])[0];
    if (!row) return null;
    const refundCents = totalRefund ? row.fee_cents : calcCommissionCents(refundedReais);
    const nextFee = Math.max(0, Number(row.fee_cents || 0) - refundCents);
    const status = nextFee <= 0 ? 'refunded' : 'partial_refund';
    const { data } = await admin.from('platform_commission').update({
      fee_cents: nextFee,
      refunded_cents: Number(row.refunded_cents || 0) + refundCents,
      status,
      updated_at: new Date().toISOString(),
    }).eq('id', row.id).select().maybeSingle();
    return data;
  } catch (e) {
    console.warn('commission reverse', e.message);
    return null;
  }
}

export function applicationFeeReais(grossReais) {
  return fromCents(calcCommissionCents(grossReais));
}
