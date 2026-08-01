import { Hono } from 'hono';
import { admin, restQuery } from './db.js';
import { toBase44Row } from './helpers.js';
import { requireUser, buildReservationMap } from './helpers.js';

const stock = new Hono();

stock.post('/start-stock-count', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const body = await c.req.json().catch(() => ({}));
    const now = new Date().toISOString();
    const payload = {
      status: 'em_andamento',
      started_at: now,
      started_by: body.started_by || user.id || null,
      started_by_name: body.started_by_name || user.full_name || user.email || '',
    };

    // 1) tenta via supabase-js
    if (admin) {
      const { data, error } = await admin.from('stock_count').insert(payload).select().maybeSingle();
      if (!error && data) return c.json(toBase44Row(data), 201);
      console.warn('start-stock-count admin insert failed', error?.message);
    }

    // 2) fallback REST com service role (contorna RLS)
    try {
      const rows = await restQuery('stock_count', { method: 'POST', body: payload });
      const row = Array.isArray(rows) ? rows[0] : rows;
      return c.json(toBase44Row(row), 201);
    } catch (e) {
      console.error('start-stock-count rest failed', e.message);
      return c.json({
        error: e.message || 'Não foi possível iniciar o balanço.',
        user_friendly: true,
        hint: 'Verifique as policies RLS da tabela stock_count no Supabase (allow insert/select para service role ou policy allow_all).',
      }, 400);
    }
  } catch (error) {
    return c.json({ error: error.message || 'Erro ao iniciar balanço.' }, 500);
  }
});


stock.post('/stock-count-search', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);
    const body = await c.req.json().catch(() => ({}));
    const q = String(body.query || body.q || '').trim();
    if (q.length < 1) return c.json({ products: [] });

    const { data } = await admin
      .from('product')
      .select('id,name,barcode,code,brand,category,stock,sale_price,cost_price,image_url,active')
      .or(`name.ilike.%${q}%,barcode.ilike.%${q}%,code.ilike.%${q}%`)
      .limit(50);

    return c.json({ products: data || [] });
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

stock.post('/stock-count-apply', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Usuário não autenticado. Faça login novamente.', user_friendly: true }, 401);
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);

    const body = await c.req.json().catch(() => ({}));
    const sessionId = body.stock_count_id;
    if (!sessionId) return c.json({ error: 'ID do balanço não informado.', user_friendly: true }, 400);

    const { data: session } = await admin.from('stock_count').select('*').eq('id', sessionId).maybeSingle();
    if (!session) return c.json({ error: 'Balanço não encontrado.', user_friendly: true }, 404);
    if (session.status === 'aplicado') {
      return c.json({ error: 'Este balanço já foi aplicado e não pode ser reaplicado.', user_friendly: true }, 400);
    }
    if (session.status === 'cancelado') {
      return c.json({ error: 'Este balanço foi cancelado e não pode ser aplicado.', user_friendly: true }, 400);
    }

    const { data: items } = await admin
      .from('stock_count_item')
      .select('*')
      .eq('stock_count_id', sessionId)
      .limit(5000);

    const { data: allProducts } = await admin.from('product').select('id,name,code,barcode,stock').limit(10000);
    const byId = Object.fromEntries((allProducts || []).map((p) => [p.id, p]));
    const byCode = {};
    const byBarcode = {};
    const byName = {};
    for (const p of allProducts || []) {
      if (p.code) byCode[String(p.code).toLowerCase()] = p;
      if (p.barcode) byBarcode[String(p.barcode)] = p;
      if (p.name) byName[String(p.name).toLowerCase()] = p;
    }

    function resolveProduct(it) {
      if (it.product_id && byId[it.product_id]) return byId[it.product_id];
      if (it.code && byCode[String(it.code).toLowerCase()]) return byCode[String(it.code).toLowerCase()];
      if (it.barcode && byBarcode[String(it.barcode)]) return byBarcode[String(it.barcode)];
      if (it.product_name && byName[String(it.product_name).toLowerCase()]) {
        return byName[String(it.product_name).toLowerCase()];
      }
      return null;
    }

    const stockSnapshot = [];
    const productUpdates = [];
    const countedProductIds = new Set();
    let totalCorrect = 0, totalSurplus = 0, totalShortage = 0;
    let totalSurplusAmount = 0, totalShortageAmount = 0;

    for (const it of items || []) {
      const p = resolveProduct(it);
      if (!p) continue;
      countedProductIds.add(p.id);
      const countedLoja = Number(it.counted_loja) || 0;
      const countedEstoque = Number(it.counted_estoque) || 0;
      const countedTotal = countedLoja + countedEstoque;
      const systemStock = Number(it.system_stock ?? p.stock) || 0;
      const currentStock = Number(p.stock) || 0;
      // movement compensation
      const finalStock = countedTotal + (currentStock - systemStock);

      stockSnapshot.push({ id: p.id, stock: currentStock });
      productUpdates.push({ id: p.id, stock: Math.max(0, finalStock) });

      const diff = countedTotal - systemStock;
      if (diff === 0) totalCorrect++;
      else if (diff > 0) { totalSurplus++; totalSurplusAmount += diff; }
      else { totalShortage++; totalShortageAmount += Math.abs(diff); }
    }

    // Zero products not found in count (if session says so)
    const zeroMissing = session.zero_missing !== false;
    if (zeroMissing) {
      for (const p of allProducts || []) {
        if (countedProductIds.has(p.id)) continue;
        if (p.active === false) continue;
        stockSnapshot.push({ id: p.id, stock: Number(p.stock) || 0 });
        productUpdates.push({ id: p.id, stock: 0 });
      }
    }

    // Apply updates
    try {
      for (const u of productUpdates) {
        await admin.from('product').update({ stock: u.stock }).eq('id', u.id);
      }
    } catch (e) {
      // rollback
      for (const s of stockSnapshot) {
        await admin.from('product').update({ stock: s.stock }).eq('id', s.id);
      }
      return c.json({ error: 'Falha ao atualizar estoque. Nenhuma alteração foi mantida.', user_friendly: true }, 500);
    }

    const now = new Date().toISOString();
    const notFoundCount = zeroMissing
      ? (allProducts || []).filter((p) => !countedProductIds.has(p.id) && p.active !== false).length
      : 0;

    try {
      await admin.from('stock_count_audit_log').insert({
        stock_count_id: sessionId,
        user_id: user.id,
        user_email: user.email,
        action: 'apply',
        details: {
          total_counted: (items || []).length,
          applied_items: productUpdates.length,
          total_surplus: totalSurplusAmount,
          total_shortage: totalShortageAmount,
        },
      });
    } catch (e) {
      console.error('audit log', e);
    }

    await admin.from('stock_count').update({
      status: 'aplicado',
      applied_at: now,
      applied_by: user.id,
      total_counted: (items || []).length,
      total_with_diff: totalSurplus + totalShortage,
      total_surplus: totalSurplusAmount,
      total_shortage: totalShortageAmount,
      total_correct: totalCorrect,
      total_not_found: notFoundCount,
    }).eq('id', sessionId);

    return c.json({
      success: true,
      total_counted: (items || []).length,
      total_with_diff: totalSurplus + totalShortage,
      total_surplus: totalSurplusAmount,
      total_shortage: totalShortageAmount,
      total_correct: totalCorrect,
      total_not_found: notFoundCount,
      applied_items: productUpdates.length,
    });
  } catch (error) {
    console.error('stock-count-apply', error);
    return c.json({ error: 'Não foi possível aplicar o balanço.', user_friendly: true }, 500);
  }
});

stock.post('/sync-pdv-reservations', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);

    const body = await c.req.json().catch(() => ({}));
    const sessionId = body.session_id || body.holder_id;
    const items = Array.isArray(body.items) ? body.items : [];
    const operatorName = body.operator_name || user.email || 'PDV';
    const expiryMinutes = Number(body.expiry_minutes) || 30;
    const allowZeroStock = body.allow_zero_stock === true;

    if (!sessionId) return c.json({ error: 'session_id obrigatório' }, 400);

    const othersMap = await buildReservationMap(sessionId);

    const { data: settingsList } = await admin
      .from('app_settings').select('*').order('created_at', { ascending: false }).limit(1);
    const reserve = Math.max(0, Number(settingsList?.[0]?.catalog_stock_reserve ?? 0) || 0);

    const { data: products } = await admin.from('product').select('*').limit(2000);
    const prodMap = Object.fromEntries((products || []).map((p) => [p.id, p]));

    const { data: own } = await admin
      .from('stock_reservation')
      .select('*')
      .eq('holder_id', sessionId)
      .eq('status', 'ativa');

    const ownByProduct = Object.fromEntries((own || []).map((r) => [r.product_id, r]));
    const expiresAt = new Date(Date.now() + expiryMinutes * 60000).toISOString();
    const desiredIds = new Set(items.map((i) => i.product_id));
    const insufficient = [];

    for (const it of items) {
      const qty = Math.max(0, Number(it.qty) || 0);
      const p = prodMap[it.product_id];
      if (!p) {
        insufficient.push({ product_id: it.product_id, name: it.name || 'Produto', available: 0 });
        continue;
      }
      const othersReserved = othersMap[p.id] || 0;
      const availableForSession = Math.max(0, (Number(p.stock) || 0) - reserve - othersReserved);
      if (qty > availableForSession && !allowZeroStock) {
        insufficient.push({ product_id: p.id, name: p.name, available: availableForSession });
        continue;
      }
      const existing = ownByProduct[p.id];
      if (existing) {
        await admin.from('stock_reservation').update({
          quantity: qty,
          product_name: p.name,
          expires_at: expiresAt,
        }).eq('id', existing.id);
      } else {
        await admin.from('stock_reservation').insert({
          product_id: p.id,
          product_name: p.name,
          quantity: qty,
          holder_id: sessionId,
          holder_name: operatorName,
          source: 'pdv',
          expires_at: expiresAt,
          status: 'ativa',
        });
      }
    }

    const toRelease = (own || []).filter((r) => !desiredIds.has(r.product_id));
    for (const r of toRelease) {
      await admin.from('stock_reservation').update({ status: 'liberada' }).eq('id', r.id);
    }

    return c.json({ ok: true, insufficient });
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

export default stock;
