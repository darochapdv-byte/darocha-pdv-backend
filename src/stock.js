import { Hono } from 'hono';
import { admin, restQuery } from './db.js';
import { toBase44Row } from './helpers.js';
import { requireUser, buildReservationMap, getAllowZeroStock } from './helpers.js';

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
      created_by: user.id,
      zero_missing: body.zero_missing === true,
    };

    // Prefer REST (service role) — supabase-js às vezes "insere" sem persistir legível em stock_count
    try {
      const rows = await restQuery('stock_count', { method: 'POST', body: payload, prefer: 'return=representation' });
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (row?.id) {
        // Confirma leitura imediata
        const check = await restQuery(`stock_count?id=eq.${encodeURIComponent(row.id)}&select=*&limit=1`);
        if (Array.isArray(check) && check[0]) return c.json(toBase44Row(check[0]), 201);
        return c.json(toBase44Row(row), 201);
      }
    } catch (e) {
      console.warn('start-stock-count rest insert', e.message);
    }

    if (admin) {
      const { data, error } = await admin.from('stock_count').insert(payload).select().maybeSingle();
      if (!error && data) return c.json(toBase44Row(data), 201);
      console.warn('start-stock-count admin insert failed', error?.message);
    }

    return c.json({
      error: 'Não foi possível iniciar o balanço.',
      user_friendly: true,
      hint: 'Verifique RLS/policies da tabela stock_count no Supabase.',
    }, 400);
  } catch (error) {
    return c.json({ error: error.message || 'Erro ao iniciar balanço.' }, 500);
  }
});

/** Busca produtos do dono para contagem — REST + filtro em memória (confiável). */
stock.post('/stock-count-search', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const body = await c.req.json().catch(() => ({}));
    const q = String(body.query || body.q || '').trim().toLowerCase();
    if (q.length < 1) return c.json({ products: [] });

    let products = [];

    // 1) REST service role
    try {
      const path = user?.id
        ? `product?created_by=eq.${encodeURIComponent(user.id)}&select=id,name,barcode,code,brand,category,stock,sale_price,cost_price,image_url,active&limit=5000`
        : `product?select=id,name,barcode,code,brand,category,stock,sale_price,cost_price,image_url,active&limit=5000`;
      const rows = await restQuery(path);
      if (Array.isArray(rows)) products = rows;
    } catch (e) {
      console.warn('stock-count-search rest', e.message);
    }

    // 2) fallback admin
    if (!products.length && admin) {
      let pq = admin
        .from('product')
        .select('id,name,barcode,code,brand,category,stock,sale_price,cost_price,image_url,active')
        .limit(5000);
      if (user?.id) pq = pq.eq('created_by', user.id);
      const { data, error } = await pq;
      if (error) console.warn('stock-count-search admin', error.message);
      products = data || [];
    }

    const matched = products.filter((p) => {
      const name = String(p.name || '').toLowerCase();
      const barcode = String(p.barcode || '').toLowerCase();
      const code = String(p.code || '').toLowerCase();
      const brand = String(p.brand || '').toLowerCase();
      return name.includes(q) || barcode.includes(q) || code.includes(q) || brand.includes(q);
    }).slice(0, 50);

    return c.json({ products: matched });
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

stock.post('/stock-count-apply', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Usuário não autenticado. Faça login novamente.', user_friendly: true }, 401);

    const body = await c.req.json().catch(() => ({}));
    const sessionId = body.stock_count_id;
    if (!sessionId) return c.json({ error: 'ID do balanço não informado.', user_friendly: true }, 400);

    // Carrega sessão via REST (contorna RLS quebrado no supabase-js)
    let session = null;
    try {
      const rows = await restQuery(`stock_count?id=eq.${encodeURIComponent(sessionId)}&select=*&limit=1`);
      session = Array.isArray(rows) ? rows[0] : rows;
    } catch (e) {
      console.warn('stock-count-apply load session rest', e.message);
    }
    if (!session && admin) {
      const { data } = await admin.from('stock_count').select('*').eq('id', sessionId).maybeSingle();
      session = data;
    }
    if (!session) return c.json({ error: 'Balanço não encontrado.', user_friendly: true }, 404);
    if (session.created_by && user?.id && session.created_by !== user.id) {
      return c.json({ error: 'Balanço não pertence a esta loja.', user_friendly: true }, 403);
    }
    if (session.status === 'aplicado') {
      return c.json({ error: 'Este balanço já foi aplicado e não pode ser reaplicado.', user_friendly: true }, 400);
    }
    if (session.status === 'cancelado') {
      return c.json({ error: 'Este balanço foi cancelado e não pode ser aplicado.', user_friendly: true }, 400);
    }

    let items = [];
    try {
      const rows = await restQuery(
        `stock_count_item?stock_count_id=eq.${encodeURIComponent(sessionId)}&select=*&limit=5000`
      );
      if (Array.isArray(rows)) items = rows;
    } catch (e) {
      console.warn('stock-count-apply items rest', e.message);
    }
    if (!items.length && admin) {
      const { data } = await admin.from('stock_count_item').select('*').eq('stock_count_id', sessionId).limit(5000);
      items = data || [];
    }

    let allProducts = [];
    try {
      const path = user?.id
        ? `product?created_by=eq.${encodeURIComponent(user.id)}&select=id,name,code,barcode,stock,active&limit=10000`
        : `product?select=id,name,code,barcode,stock,active&limit=10000`;
      const rows = await restQuery(path);
      if (Array.isArray(rows)) allProducts = rows;
    } catch (e) {
      console.warn('stock-count-apply products rest', e.message);
    }
    if (!allProducts.length && admin) {
      let allProdQ = admin.from('product').select('id,name,code,barcode,stock,active').limit(10000);
      if (user?.id) allProdQ = allProdQ.eq('created_by', user.id);
      const { data } = await allProdQ;
      allProducts = data || [];
    }

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
      const pname = it.product_name || it.name;
      if (pname && byName[String(pname).toLowerCase()]) return byName[String(pname).toLowerCase()];
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
      const countedTotal = (Number(it.counted_stock) || 0) > 0
        ? Number(it.counted_stock)
        : countedLoja + countedEstoque;
      const systemStock = Number(it.system_stock ?? p.stock) || 0;
      const currentStock = Number(p.stock) || 0;
      // Compensa movimentações durante a contagem
      const finalStock = countedTotal + (currentStock - systemStock);

      stockSnapshot.push({ id: p.id, stock: currentStock });
      productUpdates.push({ id: p.id, stock: Math.max(0, finalStock) });

      const diff = countedTotal - systemStock;
      if (diff === 0) totalCorrect++;
      else if (diff > 0) { totalSurplus++; totalSurplusAmount += diff; }
      else { totalShortage++; totalShortageAmount += Math.abs(diff); }
    }

    // Zera não contados só se explicitamente zero_missing=true (evita zerar loja por engano)
    // Mantém compat: se a sessão já tinha zero_missing true, respeita.
    const zeroMissing = !(session.zero_missing === false || body.zero_missing === false);
    if (zeroMissing) {
      for (const p of allProducts || []) {
        if (countedProductIds.has(p.id)) continue;
        if (p.active === false) continue;
        stockSnapshot.push({ id: p.id, stock: Number(p.stock) || 0 });
        productUpdates.push({ id: p.id, stock: 0 });
      }
    }

    // Aplica atualizações de estoque via REST (mais confiável)
    try {
      for (const u of productUpdates) {
        const filter = user?.id
          ? `product?id=eq.${encodeURIComponent(u.id)}&created_by=eq.${encodeURIComponent(user.id)}`
          : `product?id=eq.${encodeURIComponent(u.id)}`;
        try {
          await restQuery(filter, { method: 'PATCH', body: { stock: u.stock }, prefer: 'return=minimal' });
        } catch (e) {
          if (admin) {
            await admin.from('product').update({ stock: u.stock }).eq('id', u.id).eq('created_by', user.id);
          } else {
            throw e;
          }
        }
      }
    } catch (e) {
      for (const s of stockSnapshot) {
        try {
          const filter = user?.id
            ? `product?id=eq.${encodeURIComponent(s.id)}&created_by=eq.${encodeURIComponent(user.id)}`
            : `product?id=eq.${encodeURIComponent(s.id)}`;
          await restQuery(filter, { method: 'PATCH', body: { stock: s.stock }, prefer: 'return=minimal' });
        } catch (_) {}
      }
      return c.json({ error: 'Falha ao atualizar estoque. Nenhuma alteração foi mantida.', user_friendly: true }, 500);
    }

    const now = new Date().toISOString();
    const notFoundCount = zeroMissing
      ? (allProducts || []).filter((p) => !countedProductIds.has(p.id) && p.active !== false).length
      : 0;

    try {
      await restQuery('stock_count_audit_log', {
        method: 'POST',
        body: {
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
        },
        prefer: 'return=minimal',
      });
    } catch (e) {
      console.error('audit log', e.message || e);
    }

    const sessionPatch = {
      status: 'aplicado',
      applied_at: now,
      applied_by: user.id,
      total_counted: (items || []).length,
      total_with_diff: totalSurplus + totalShortage,
      total_surplus: totalSurplusAmount,
      total_shortage: totalShortageAmount,
      total_correct: totalCorrect,
      total_not_found: notFoundCount,
    };
    try {
      await restQuery(`stock_count?id=eq.${encodeURIComponent(sessionId)}`, {
        method: 'PATCH',
        body: sessionPatch,
        prefer: 'return=minimal',
      });
    } catch (e) {
      if (admin) {
        await admin.from('stock_count').update(sessionPatch).eq('id', sessionId);
      } else {
        console.error('session status update', e.message || e);
      }
    }

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
    const allowZeroStock = (await getAllowZeroStock()) || body.allow_zero_stock === true;

    if (!sessionId) return c.json({ error: 'session_id obrigatório' }, 400);

    const othersMap = await buildReservationMap(sessionId);

    const { data: settingsList } = await admin
      .from('app_settings').select('*').order('created_at', { ascending: false }).limit(1);
    const reserve = Math.max(0, Number(settingsList?.[0]?.catalog_stock_reserve ?? 0) || 0);

    let resProdQ = admin.from('product').select('*').limit(2000);
    if (user?.id) resProdQ = resProdQ.eq('created_by', user.id);
    const { data: products } = await resProdQ;
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
