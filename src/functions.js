import { Hono } from 'hono';
import { admin } from './db.js';
import { logOperation, releaseSessionReservations, requireUser, stackOf, sanitizeDateFields } from './helpers.js';

/**
 * Backend functions portadas da Base44.
 * Frontend: base44.functions.invoke('nome', payload) → POST /functions/nome
 */

const functions = new Hono();
const INACTIVE_THRESHOLD_MS = 5 * 60 * 1000;

// ─── product-inquiry ───────────────────────────────────────────────────────

functions.post('/product-inquiry', async (c) => {
  const apiKey = c.req.header('x-api-key');
  const expected = process.env.ASSISTANT_API_KEY;
  if (!expected || apiKey !== expected) return c.json({ error: 'unauthorized' }, 401);
  if (!admin) return c.json({ error: 'db_unavailable' }, 503);

  const body = await c.req.json().catch(() => ({}));
  const { action = 'search', query, barcode, category, limit = 50, offset = 0, active_only = true } = body;

  const { data: settingsList } = await admin
    .from('app_settings')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1);
  const settings = settingsList?.[0];
  if (settings && settings.assistant_access_enabled === false) {
    return c.json({ error: 'assistant_disabled' }, 403);
  }

  const fields = settings?.assistant_exposed_fields || [
    'name', 'sale_price', 'stock', 'category', 'description', 'barcode',
  ];
  const selectCols = ['id', ...fields].join(',');

  if (action === 'categories') {
    const { data } = await admin.from('product').select('category').eq('active', true);
    const counts = {};
    for (const p of data || []) {
      const cat = p.category || 'Sem categoria';
      counts[cat] = (counts[cat] || 0) + 1;
    }
    return c.json({ categories: counts });
  }

  if (action === 'get' && barcode) {
    const { data } = await admin.from('product').select(selectCols).eq('barcode', barcode).maybeSingle();
    if (!data) return c.json({ found: false });
    return c.json({ found: true, product: data });
  }

  if (action === 'similar' && barcode) {
    const { data: origin } = await admin.from('product').select('*').eq('barcode', barcode).maybeSingle();
    if (!origin) return c.json({ found: false });
    let q = admin.from('product').select(selectCols).neq('id', origin.id).limit(10);
    if (origin.category) q = q.eq('category', origin.category);
    const { data: similar } = await q;
    return c.json({ found: true, product: origin, similar: similar || [] });
  }

  let q = admin.from('product').select(selectCols);
  if (active_only) q = q.eq('active', true);
  if (category) q = q.eq('category', category);
  if (query) q = q.or(`name.ilike.%${query}%,barcode.ilike.%${query}%,brand.ilike.%${query}%`);
  q = q.range(Number(offset), Number(offset) + Number(limit) - 1);
  const { data, error } = await q;
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ products: data || [], count: (data || []).length });
});

// ─── open-cash-session ─────────────────────────────────────────────────────

functions.post('/open-cash-session', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);

    const body = await c.req.json().catch(() => ({}));
    const { operator_id, operator_name, device_id } = body;
    if (!operator_id) return c.json({ error: 'Selecione o funcionário.' }, 400);
    if (!device_id) return c.json({ error: 'Dispositivo não identificado.' }, 400);

    const operatorIsVendedor = Array.isArray(body.operator_funcoes) && body.operator_funcoes.includes('vendedor');
    const payload = {
      opening_amount: Number(body.opening_amount) || 0,
      operator_id,
      operator_name: operator_name || '',
      operator_funcoes: body.operator_funcoes || [],
      device_id,
      seller_id: operatorIsVendedor ? operator_id : '',
      seller_control_mode: operatorIsVendedor ? 'sem_vendedores' : 'com_vendedores',
      commission_percent: operatorIsVendedor ? Number(body.commission_percent) || 0 : 0,
      terminal: body.terminal || '',
      status: 'aberto',
      last_active_at: new Date().toISOString(),
    };

    const { data: session, error } = await admin.from('cash_session').insert(payload).select().single();
    if (error) return c.json({ error: error.message }, 500);
    return c.json({ session, resumed: false });
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

// ─── takeover-cash-session ─────────────────────────────────────────────────

functions.post('/takeover-cash-session', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);

    const body = await c.req.json().catch(() => ({}));
    const { session_id, device_id } = body;
    if (!session_id) return c.json({ error: 'Sessão não informada.' }, 400);
    if (!device_id) return c.json({ error: 'Dispositivo não identificado.' }, 400);

    const { data: session } = await admin.from('cash_session').select('*').eq('id', session_id).maybeSingle();
    if (!session) return c.json({ error: 'Caixa não encontrado.' }, 404);
    if (session.status !== 'aberto') {
      return c.json({ error: 'Este caixa já foi fechado e não pode ser assumido.' }, 400);
    }
    if (session.device_id === device_id) return c.json({ session, resumed: true });

    const existingHistory = Array.isArray(session.takeover_history) ? session.takeover_history : [];
    const entry = {
      at: new Date().toISOString(),
      operator_name: user.full_name || user.email || session.operator_name || '',
      device_id,
      terminal: body.terminal || session.terminal || '',
    };

    const { data: updated, error } = await admin
      .from('cash_session')
      .update({
        device_id,
        terminal: body.terminal || session.terminal || '',
        takeover_history: [...existingHistory, entry],
        inactive: false,
        last_active_at: entry.at,
      })
      .eq('id', session_id)
      .select()
      .single();

    if (error) return c.json({ error: error.message }, 500);

    await logOperation({
      type: 'cash_recovery', level: 'warn',
      description: `Caixa ${session_id} assumido por ${entry.operator_name} no dispositivo ${device_id}.`,
      operator_name: entry.operator_name, device_id, cash_session_id: session_id,
    });

    return c.json({ session: updated, resumed: false });
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

// ─── cash-session-heartbeat ────────────────────────────────────────────────

functions.post('/cash-session-heartbeat', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);

    const body = await c.req.json().catch(() => ({}));
    const session_id = body.session_id;
    const device_id = body.device_id || '';
    if (!session_id) return c.json({ error: 'Sessão não informada.' }, 400);

    const { data: session } = await admin.from('cash_session').select('*').eq('id', session_id).maybeSingle();
    if (!session) return c.json({ error: 'Caixa não encontrado.' }, 404);
    if (session.status !== 'aberto') return c.json({ error: 'Caixa fechado.' }, 400);

    if (session.device_id && device_id && session.device_id !== device_id) {
      return c.json({ ok: true, foreign: true });
    }

    const now = new Date().toISOString();
    const updates = { last_active_at: now };
    if (session.inactive) updates.inactive = false;
    await admin.from('cash_session').update(updates).eq('id', session_id);
    return c.json({ ok: true, last_active_at: now });
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

// ─── release-pdv-reservations ──────────────────────────────────────────────

functions.post('/release-pdv-reservations', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Não autorizado' }, 401);
    const body = await c.req.json().catch(() => ({}));
    if (!body.session_id) return c.json({ error: 'Sessão de caixa obrigatória' }, 400);
    const released = await releaseSessionReservations(body.session_id);
    return c.json({ ok: true, released });
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

// ─── finalize-sale ─────────────────────────────────────────────────────────

functions.post('/finalize-sale', async (c) => {
  let session_id = '';
  let device_id = '';
  let client_ref = '';
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);

    const body = await c.req.json().catch(() => ({}));
    const sale = sanitizeDateFields(body.sale || body);
    session_id = body.session_id || sale.cash_session_id || '';
    device_id = body.device_id || '';
    client_ref = sale.client_ref || '';
    const allowZeroStock = body.allow_zero_stock === true;
    const items = Array.isArray(sale.items) ? sale.items : [];
    const operator_name = sale.operator_name || user.full_name || user.email || '';

    if (!items.length) {
      return c.json({ error: 'Carrinho vazio. Nenhuma alteração foi realizada.' }, 400);
    }

    // RPC atômica (se 002_finalize_sale_rpc.sql foi aplicado)
    const { data: rpcResult, error: rpcError } = await admin.rpc('finalize_sale', {
      p_items: items,
      p_sale: { ...sale, operator_name },
      p_session_id: session_id || null,
      p_allow_zero_stock: allowZeroStock,
    });

    if (!rpcError && rpcResult) {
      if (rpcResult.error) {
        const status = rpcResult.insufficient ? 409 : 400;
        if (rpcResult.insufficient) {
          await logOperation({
            type: 'finalize_failure', level: 'warn',
            description: `Estoque insuficiente: ${JSON.stringify(rpcResult.insufficient)}`,
            operator_name, device_id, cash_session_id: session_id, client_ref,
          });
        }
        return c.json(rpcResult, status);
      }
      return c.json(rpcResult);
    }

    console.warn('finalize_sale RPC unavailable, JS fallback:', rpcError?.message);

    if (client_ref) {
      const { data: existing } = await admin
        .from('sale').select('*').eq('client_ref', client_ref)
        .order('created_at', { ascending: false }).limit(1);
      if (existing?.length) {
        if (session_id) await releaseSessionReservations(session_id);
        return c.json(existing[0]);
      }
    }

    const ids = items.map((i) => i.product_id).filter(Boolean);
    const { data: products } = await admin.from('product').select('id,name,stock').in('id', ids);
    const stockMap = Object.fromEntries((products || []).map((p) => [p.id, p]));

    const insufficient = [];
    for (const it of items) {
      const p = stockMap[it.product_id];
      if (!p) {
        insufficient.push({ product_id: it.product_id, name: it.name || 'Produto', available: 0, requested: it.qty });
        continue;
      }
      const avail = Math.max(0, Number(p.stock) || 0);
      if (avail < Number(it.qty)) {
        insufficient.push({ product_id: it.product_id, name: p.name, available: avail, requested: it.qty });
      }
    }
    if (insufficient.length && !allowZeroStock) {
      await logOperation({
        type: 'finalize_failure', level: 'warn',
        description: `Estoque insuficiente: ${insufficient.map((i) => i.name).join(', ')}`,
        operator_name, device_id, cash_session_id: session_id, client_ref,
      });
      return c.json({
        error: 'Estoque insuficiente para um ou mais itens. A venda não foi concluída.',
        insufficient,
      }, 409);
    }

    for (const it of items) {
      const current = Number(stockMap[it.product_id]?.stock) || 0;
      const next = Math.max(0, current - Number(it.qty));
      const { error } = await admin.from('product').update({ stock: next }).eq('id', it.product_id);
      if (error) {
        for (const prev of items) {
          if (stockMap[prev.product_id]) {
            await admin.from('product').update({ stock: stockMap[prev.product_id].stock }).eq('id', prev.product_id);
          }
        }
        return c.json({ error: 'Falha ao dar baixa no estoque. Nenhuma alteração permaneceu.' }, 500);
      }
    }

    const salePayload = {
      ...sale, items,
      cash_session_id: session_id || sale.cash_session_id,
      client_ref: client_ref || sale.client_ref,
      operator_name,
      status: sale.status || 'concluida',
    };

    const { data: createdSale, error: sErr } = await admin.from('sale').insert(salePayload).select().single();
    if (sErr) {
      for (const prev of items) {
        if (stockMap[prev.product_id]) {
          await admin.from('product').update({ stock: stockMap[prev.product_id].stock }).eq('id', prev.product_id);
        }
      }
      return c.json({ error: 'Falha ao registrar a venda. Estoque restaurado.' }, 500);
    }

    if (session_id) await releaseSessionReservations(session_id);
    return c.json(createdSale);
  } catch (error) {
    await logOperation({
      type: 'unexpected_error', level: 'error',
      description: `Erro inesperado: ${error?.message || error}`,
      device_id, cash_session_id: session_id, client_ref, stack_trace: stackOf(error),
    }).catch(() => {});
    return c.json({ error: error.message || 'Erro ao finalizar venda.' }, 500);
  }
});

// ─── catch-all ─────────────────────────────────────────────────────────────

functions.post('/:name', async (c) => {
  const name = c.req.param('name');
  const implemented = [
  'open-cash-session','takeover-cash-session','cash-session-heartbeat','finalize-sale',
  'release-pdv-reservations','product-inquiry',
  'catalog-data','catalog-checkout','catalog-store-status','catalog-receipt','catalog-expire-pickups',
  'barcode-lookup','product-name-lookup','enrich-product','save-product','refresh-products-catalog',
  'stock-count-search','stock-count-apply','sync-pdv-reservations',
  'admin-stats','cleanup-cash-sessions','purge-account','init-help-content',
  'create-checkout','stripe-webhook','init-subscription','link-referral',
  'fetch-nfe-xml','import-nfe','address-search',
];
  if (implemented.includes(name)) return c.json({ error: 'routing_error' }, 500);
  return c.json({
    error: 'function_not_ported',
    message: `Function "${name}" ainda não migrada.`,
    name,
  }, 501);
});

export default functions;
