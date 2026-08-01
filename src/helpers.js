import { admin } from './db.js';

export function stackOf(error) {
  return (error && (error.stack || error.message)) || String(error || '');
}

export async function logOperation(entry) {
  if (!admin) return;
  try {
    await admin.from('operational_log').insert({
      type: entry.type || 'unexpected_error',
      level: entry.level || 'info',
      description: String(entry.description || '').slice(0, 2000),
      operator_name: entry.operator_name || '',
      device_id: entry.device_id || '',
      cash_session_id: entry.cash_session_id || '',
      sale_id: entry.sale_id || '',
      client_ref: entry.client_ref || '',
      stack_trace: String(entry.stack_trace || '').slice(0, 4000),
    });
  } catch (e) {
    console.error('logOperation failed', e);
  }
}

/** Libera reservas ativas de uma sessão de caixa */
export async function releaseSessionReservations(sessionId) {
  if (!sessionId || !admin) return 0;
  try {
    const { data: own } = await admin
      .from('stock_reservation')
      .select('id')
      .eq('holder_id', sessionId)
      .eq('status', 'ativa')
      .limit(2000);
    if (!own?.length) return 0;
    await admin
      .from('stock_reservation')
      .update({ status: 'liberada' })
      .in(
        'id',
        own.map((r) => r.id)
      );
    return own.length;
  } catch (e) {
    console.error('releaseSessionReservations error', e);
    return 0;
  }
}

/** Extrai usuário do request (JWT local ou Supabase) */
export async function requireUser(c) {
  const { getUserFromRequest } = await import('./auth.js');
  return getUserFromRequest(c);
}

/** Limpa reservas expiradas e retorna mapa product_id → qty reservada */
export async function buildReservationMap(excludeHolderId = null) {
  if (!admin) return {};
  try {
    const now = new Date().toISOString();
    const { data: active } = await admin
      .from('stock_reservation')
      .select('*')
      .eq('status', 'ativa')
      .limit(3000);
    const expired = (active || []).filter((r) => r.expires_at && r.expires_at < now);
    if (expired.length) {
      await admin
        .from('stock_reservation')
        .update({ status: 'liberada' })
        .in('id', expired.map((r) => r.id));
    }
    const map = {};
    for (const r of active || []) {
      if (r.expires_at && r.expires_at < now) continue;
      if (excludeHolderId && r.holder_id === excludeHolderId) continue;
      map[r.product_id] = (map[r.product_id] || 0) + (Number(r.quantity) || 0);
    }
    return map;
  } catch (e) {
    console.error('buildReservationMap', e);
    return {};
  }
}

export function computeCatalogAvailable(stock, reserve, reservedQty) {
  const s = Math.max(0, Number(stock) || 0);
  const res = Math.max(0, Number(reserve) || 0);
  const rq = Math.max(0, Number(reservedQty) || 0);
  return Math.max(0, s - res - rq);
}

export function sanitizeDateFields(data) {
  if (!data || typeof data !== 'object') return data;

  const sanitizedData = { ...data };
  for (const key in sanitizedData) {
    if (key.includes('date') || key.includes('at')) { // Heuristic for date fields
      if (sanitizedData[key] === '' || sanitizedData[key] === undefined) {
        sanitizedData[key] = null;
      }
    }
  }
  return sanitizedData;
}
