import { Hono } from 'hono';
import { admin } from './db.js';
import { logOperation, releaseSessionReservations, requireUser, stackOf, sanitizeDateFields, toBase44Row, toBase44Rows, getAllowZeroStock } from './helpers.js';
import { registerCashMovement } from './integration.js';

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

  // Isola produtos da loja dona das settings do assistente
  const storeOwnerId = settings?.created_by || null;

  const fields = settings?.assistant_exposed_fields || [
    'name', 'sale_price', 'stock', 'category', 'description', 'barcode',
  ];
  const selectCols = ['id', ...fields].join(',');

  if (action === 'categories') {
    let cq = admin.from('product').select('category').eq('active', true);
    if (storeOwnerId) cq = cq.eq('created_by', storeOwnerId);
    const { data } = await cq;
    const counts = {};
    for (const p of data || []) {
      const cat = p.category || 'Sem categoria';
      counts[cat] = (counts[cat] || 0) + 1;
    }
    return c.json({ categories: counts });
  }

  if (action === 'get' && barcode) {
    let gq = admin.from('product').select(selectCols).eq('barcode', barcode);
    if (storeOwnerId) gq = gq.eq('created_by', storeOwnerId);
    const { data } = await gq.maybeSingle();
    if (!data) return c.json({ found: false });
    return c.json({ found: true, product: data });
  }

  if (action === 'similar' && barcode) {
    let oq = admin.from('product').select('*').eq('barcode', barcode);
    if (storeOwnerId) oq = oq.eq('created_by', storeOwnerId);
    const { data: origin } = await oq.maybeSingle();
    if (!origin) return c.json({ found: false });
    let q = admin.from('product').select(selectCols).neq('id', origin.id).limit(10);
    if (storeOwnerId) q = q.eq('created_by', storeOwnerId);
    if (origin.category) q = q.eq('category', origin.category);
    const { data: similar } = await q;
    return c.json({ found: true, product: origin, similar: similar || [] });
  }

  let q = admin.from('product').select(selectCols);
  if (storeOwnerId) q = q.eq('created_by', storeOwnerId);
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

    // 1) Mesmo operador + mesmo dispositivo + mesma loja → retoma
    const { data: existingSame } = await admin
      .from('cash_session')
      .select('*')
      .eq('operator_id', operator_id)
      .eq('device_id', device_id)
      .eq('status', 'aberto')
      .eq('created_by', user.id)
      .order('created_at', { ascending: false })
      .limit(1);

    if (existingSame?.length) {
      const session = existingSame[0];
      await admin.from('cash_session').update({
        last_active_at: new Date().toISOString(),
        inactive: false,
      }).eq('id', session.id);
      return c.json({ session: toBase44Row(session), resumed: true });
    }

    // 2) Permite MÚLTIPLOS caixas abertos ao mesmo tempo.
    //    Qualquer operador pode abrir um novo caixa em qualquer dispositivo.
    //    (Não bloqueia mais por "terminal já ocupado" nem por "operador em outro device")

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
      created_by: user.id,
    };

    const { data: session, error } = await admin.from('cash_session').insert(payload).select().single();
    if (error) return c.json({ error: error.message }, 500);
    return c.json({ session: toBase44Row(session), resumed: false });
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
    // Só a própria loja pode assumir o caixa
    if (session.created_by && session.created_by !== user.id) {
      return c.json({ error: 'Caixa não pertence a esta loja.' }, 403);
    }
    if (session.status !== 'aberto') {
      return c.json({ error: 'Este caixa já foi fechado e não pode ser assumido.' }, 400);
    }
    if (session.device_id === device_id) return c.json({ session: toBase44Row(session), resumed: true });


    const existingHistory = Array.isArray(session.takeover_history) ? session.takeover_history : [];
    const entry = {
      at: new Date().toISOString(),
      operator_name: user.full_name || user.email || session.operator_name || '',
      device_id,
      terminal: body.terminal || session.terminal || '',
    };

    const previousDeviceId = session.device_id || null;

    // Só atualiza colunas que JÁ existem na tabela cash_session
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
      description: `Caixa ${session_id} assumido por ${entry.operator_name} no dispositivo ${device_id} (antes: ${previousDeviceId || 'nenhum'}).`,
      operator_name: entry.operator_name, device_id, cash_session_id: session_id,
    });

    // Dispositivo anterior fica inválido:
    // - heartbeat → force_exit
    // - finalize-sale → bloqueado
    return c.json({
      session: toBase44Row(updated),
      resumed: false,
      exclusive: true,
      previous_device_id: previousDeviceId,
      message: 'Caixa assumido neste dispositivo. O outro aparelho será desconectado automaticamente.',
    });


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
    if (!session) return c.json({ error: 'Caixa não encontrado.', force_exit: true }, 404);
    if (session.status !== 'aberto') {
      return c.json({
        ok: false,
        force_exit: true,
        reason: 'closed',
        message: 'Este caixa foi fechado. Saia do PDV e abra novamente se necessário.',
      }, 409);
    }

    // Caixa foi assumido em outro dispositivo → força saída neste aparelho
    if (session.device_id && device_id && session.device_id !== device_id) {
      return c.json({
        ok: false,
        foreign: true,
        force_exit: true,
        reason: 'taken_over',
        message: 'Este caixa foi assumido em outro dispositivo. Você foi desconectado.',
        current_device_id: session.device_id,
      }, 409);
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

functions.post("/list-open-cash-sessions", async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);

    // Lista caixas abertos da própria loja (isolamento multi-tenant)
    let q = admin
      .from('cash_session')
      .select('*')
      .eq('status', 'aberto')
      .order('created_at', { ascending: false });
    if (user?.id) q = q.eq('created_by', user.id);
    const { data: openSessions, error } = await q;

    if (error) return c.json({ error: error.message }, 500);
    return c.json(toBase44Rows(openSessions));

  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

// ─── finalize-sale ─────────────────────────────────────────────────────────

functions.post("/finalize-sale", async (c) => {
  let session_id = '';
  let device_id = '';
  let client_ref = '';
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);

    const body = await c.req.json().catch(() => ({}));
    // Recupera vendas PDV órfãs (created_by null) ligadas a caixas desta loja
    try {
      const { data: sessions } = await admin.from('cash_session').select('id').eq('created_by', user.id).limit(100);
      const sids = (sessions || []).map((x) => x.id).filter(Boolean);
      if (sids.length) {
        await admin.from('sale').update({ created_by: user.id }).is('created_by', null).in('cash_session_id', sids);
      }
    } catch (e) {
      console.warn('orphan sale ownership recovery', e?.message || e);
    }
    const sale = sanitizeDateFields(body.sale || body);
    session_id = body.session_id || sale.cash_session_id || '';
    device_id = body.device_id || '';
    client_ref = sale.client_ref || '';
    // Política "vender sem estoque" da própria loja
    let allowZeroStock = body.allow_zero_stock === true;
    try {
      const { data: ownSettings } = await admin
        .from('app_settings').select('allow_zero_stock')
        .eq('created_by', user.id)
        .order('created_at', { ascending: false }).limit(20);
      if ((ownSettings || []).some((s) => s && s.allow_zero_stock === true)) allowZeroStock = true;
      else if (!allowZeroStock) allowZeroStock = await getAllowZeroStock(user.id);
    } catch {
      try { allowZeroStock = (await getAllowZeroStock(user.id)) || allowZeroStock; }
      catch { allowZeroStock = (await getAllowZeroStock()) || allowZeroStock; }
    }
    const items = Array.isArray(sale.items) ? sale.items : [];
    const operator_name = sale.operator_name || user.full_name || user.email || '';

    if (!items.length) {
      return c.json({ error: 'Carrinho vazio. Nenhuma alteração foi realizada.' }, 400);
    }

    // Cada caixa específico só pode ser usado por UM dispositivo por vez (e só da própria loja)
    if (session_id) {
      const { data: cashSession } = await admin
        .from('cash_session')
        .select('id,status,device_id,created_by')
        .eq('id', session_id)
        .maybeSingle();
      if (!cashSession || cashSession.status !== 'aberto') {
        return c.json({
          error: 'Caixa fechado ou inválido. Abra o caixa novamente.',
          force_exit: true,
          reason: 'closed',
        }, 409);
      }
      if (cashSession.created_by && cashSession.created_by !== user.id) {
        return c.json({
          error: 'Caixa não pertence a esta loja.',
          force_exit: true,
          reason: 'wrong_store',
        }, 403);
      }
      // Se o dispositivo mudou mas o caixa é da mesma loja, assume neste aparelho e segue a venda
      if (device_id && cashSession.device_id && cashSession.device_id !== device_id) {
        try {
          await admin.from('cash_session').update({
            device_id,
            last_active_at: new Date().toISOString(),
            inactive: false,
          }).eq('id', session_id);
        } catch (e) {
          console.warn('auto-takeover device on finalize', e?.message || e);
        }
      } else if (device_id && !cashSession.device_id) {
        try {
          await admin.from('cash_session').update({ device_id, last_active_at: new Date().toISOString() }).eq('id', session_id);
        } catch (_) {}
      }
    }



    // RPC atômica (se 002_finalize_sale_rpc.sql foi aplicado)
    const { data: rpcResult, error: rpcError } = await admin.rpc('finalize_sale', {
      p_items: items,
      p_sale: { ...sale, operator_name, created_by: user.id, source: sale.source || 'pdv' },
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
      // Frontend espera { sale: ... }
      // A RPC costuma gravar sem created_by e sem campos de entrega/cliente — completa agora
      let saleRow = rpcResult.sale || rpcResult;
      const saleId = saleRow && (saleRow.id || rpcResult.sale_id);
      if (saleId) {
        const patch = {
          created_by: user.id,
          source: sale.source || saleRow.source || 'pdv',
          operator_name: operator_name || saleRow.operator_name || null,
          customer_name: sale.customer_name ?? saleRow.customer_name ?? null,
          customer_phone: sale.customer_phone ?? saleRow.customer_phone ?? null,
          customer_id: sale.customer_id || saleRow.customer_id || null,
          delivery_type: sale.delivery_type || saleRow.delivery_type || null,
          delivery_address: sale.delivery_address ?? saleRow.delivery_address ?? null,
          delivery_number: sale.delivery_number ?? saleRow.delivery_number ?? null,
          delivery_neighborhood: sale.delivery_neighborhood ?? saleRow.delivery_neighborhood ?? null,
          delivery_complement: sale.delivery_complement ?? saleRow.delivery_complement ?? null,
          delivery_reference: sale.delivery_reference ?? saleRow.delivery_reference ?? null,
          delivery_city: sale.delivery_city ?? saleRow.delivery_city ?? null,
          delivery_state: sale.delivery_state ?? saleRow.delivery_state ?? null,
          delivery_cep: sale.delivery_cep ?? saleRow.delivery_cep ?? null,
          delivery_person: sale.delivery_person ?? saleRow.delivery_person ?? null,
          delivery_fee: sale.delivery_fee != null ? Number(sale.delivery_fee) : (saleRow.delivery_fee ?? 0),
          payment_method: sale.payment_method || saleRow.payment_method || null,
          installments: sale.installments != null ? sale.installments : saleRow.installments,
          discount: sale.discount != null ? sale.discount : saleRow.discount,
          subtotal: sale.subtotal != null ? sale.subtotal : saleRow.subtotal,
          fee_amount: sale.fee_amount != null ? sale.fee_amount : saleRow.fee_amount,
          change_amount: sale.change_amount != null ? sale.change_amount : saleRow.change_amount,
          cash_received: sale.cash_received != null ? sale.cash_received : saleRow.cash_received,
          cash_change_for: sale.cash_change_for != null ? sale.cash_change_for : saleRow.cash_change_for,
          notes: sale.notes ?? saleRow.notes ?? null,
          seller_name: sale.seller_name ?? saleRow.seller_name ?? null,
          seller_id: sale.seller_id || saleRow.seller_id || null,
          items: Array.isArray(sale.items) ? sale.items : saleRow.items,
        };
        // remove undefined to avoid wiping columns
        Object.keys(patch).forEach((k) => { if (patch[k] === undefined) delete patch[k]; });
        try {
          const { data: fixed, error: fixErr } = await admin
            .from('sale')
            .update(patch)
            .eq('id', saleId)
            .select()
            .maybeSingle();
          if (fixErr) console.warn('patch sale after RPC', fixErr.message);
          if (fixed) saleRow = fixed;
          else saleRow = { ...saleRow, ...patch, id: saleId };
        } catch (e) {
          console.warn('patch sale after finalize_sale RPC', e?.message || e);
          saleRow = { ...saleRow, ...patch, id: saleId };
        }
      }
      return c.json({ ok: true, success: true, sale: toBase44Row(saleRow), sale_id: saleId || saleRow.id });
    }

    console.warn('finalize_sale RPC unavailable, JS fallback:', rpcError?.message);

    if (client_ref) {
      const { data: existing } = await admin
        .from('sale').select('*').eq('client_ref', client_ref)
        .order('created_at', { ascending: false }).limit(1);
      if (existing?.length) {
        if (session_id) await releaseSessionReservations(session_id);
        return c.json({ ok: true, success: true, sale: toBase44Row(existing[0]), sale_id: existing[0].id });
      }
    }

    const ids = items.map((i) => i.product_id).filter(Boolean);
    let prodQ = admin.from('product').select('id,name,stock,created_by').in('id', ids);
    if (user?.id) prodQ = prodQ.eq('created_by', user.id);
    const { data: products } = await prodQ;
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
      let uq = admin.from('product').update({ stock: next }).eq('id', it.product_id);
      if (user?.id) uq = uq.eq('created_by', user.id);
      const { error } = await uq;
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
      source: sale.source || 'pdv',
      created_by: user.id,
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
    // Registra venda no caixa (módulo Caixas Abertos integrado)
    if (session_id) {
      try {
        await registerCashMovement({
          cash_session_id: session_id,
          type: 'venda',
          amount: Number(createdSale.total) || 0,
          reason: `Venda PDV #${String(createdSale.id).slice(-6).toUpperCase()}`,
          sale_id: createdSale.id,
          operator_name,
        });
      } catch (e) {
        console.warn('cash movement on finalize-sale', e.message);
      }
    }
    // Frontend espera response.data.sale
    return c.json({ ok: true, success: true, sale: toBase44Row(createdSale), sale_id: createdSale.id });
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
  'open-cash-session','takeover-cash-session','cash-session-heartbeat','list-open-cash-sessions','finalize-sale','delivery-assign','delivery-complete','settle-accountability','courier-balance',
  'release-pdv-reservations','product-inquiry',
  'catalog-data','catalog-checkout','catalog-store-status','catalog-receipt','catalog-expire-pickups',
  'barcode-lookup','product-name-lookup','enrich-product','save-product','repair-product-ownership','refresh-products-catalog',
  'start-stock-count','stock-count-search','stock-count-apply','sync-pdv-reservations',
  'admin-stats','cleanup-cash-sessions','purge-account','init-help-content',
  'create-checkout','stripe-webhook','init-subscription','link-referral','subscription-status','referral-panel','master-code-status',
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
