import { Hono } from 'hono';
import { admin } from './db.js';
import { logOperation, releaseSessionReservations, requireUser, stackOf, sanitizeDateFields, toBase44Row, toBase44Rows, getAllowZeroStock, upsertCustomer, ensureCatalogSlug, buildStorePublicUrl } from './helpers.js';
import { registerCashMovement } from './integration.js';
import { getAccessStatus } from './stripe_ops.js';

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

    // 2) Fecha caixas zumbis da mesma loja (sem atividade há 12h+)
    //    Mantém múltiplos caixas legítimos ativos no turno.
    try {
      const staleCut = new Date(Date.now() - 12 * 60 * 60000).toISOString();
      let sq = admin.from('cash_session').select('id,last_active_at,last_heartbeat,updated_at,created_at')
        .eq('status', 'aberto').eq('created_by', user.id).limit(200);
      const { data: staleOpen } = await sq;
      for (const s of staleOpen || []) {
        const last = s.last_active_at || s.last_heartbeat || s.updated_at || s.created_at;
        if (last && last < staleCut) {
          await admin.from('cash_session').update({
            status: 'fechado',
            closed_at: new Date().toISOString(),
            notes: 'auto_stale_on_open',
          }).eq('id', s.id);
        }
      }
    } catch (e) {
      console.warn('stale cash cleanup on open', e?.message || e);
    }

    // 3) Permite MÚLTIPLOS caixas abertos ao mesmo tempo (turno real).
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

    // Atualiza device_id (obrigatório). Campos extras tentados; se a coluna não existir, tenta só o essencial.
    const fullPatch = {
      device_id,
      terminal: body.terminal || session.terminal || '',
      takeover_history: [...existingHistory, entry],
      inactive: false,
      last_active_at: entry.at,
    };
    let updated = null;
    let error = null;
    ({ data: updated, error } = await admin
      .from('cash_session')
      .update(fullPatch)
      .eq('id', session_id)
      .select()
      .single());

    if (error) {
      // Fallback: só device_id + terminal (colunas garantidas)
      const minimal = {
        device_id,
        terminal: body.terminal || session.terminal || '',
      };
      ({ data: updated, error } = await admin
        .from('cash_session')
        .update(minimal)
        .eq('id', session_id)
        .select()
        .single());
      if (error) return c.json({ error: error.message || 'Falha ao assumir o caixa.' }, 500);
    }

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
    if (!user) {
      return c.json({
        error: 'Sessão expirada ou não autorizada. Faça login novamente e tente finalizar a venda.',
        code: 'session_expired',
        force_login: true,
      }, 401);
    }
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

    // Vale (fiado/a prazo): exige nome + telefone para cobrança e notificações
    {
      const pm = String(sale.payment_method || '').toLowerCase();
      const payments = Array.isArray(sale.payments) ? sale.payments : [];
      const hasVale =
        pm === 'vale' ||
        (pm === 'misto' &&
          payments.some(
            (p) => String(p?.method || p?.payment_method || '').toLowerCase() === 'vale'
          ));
      if (hasVale) {
        const name = String(
          sale.customer_name || sale.client_name || sale.delivery_person || ''
        ).trim();
        const phoneRaw = String(
          sale.customer_phone || sale.client_phone || sale.delivery_phone || ''
        );
        const phoneDigits = phoneRaw.replace(/\D/g, '');
        if (name.length < 2) {
          return c.json(
            {
              error:
                'No pagamento em vale, informe o nome do cliente para registrar a pendência e cobrar depois.',
              code: 'vale_customer_name_required',
            },
            400
          );
        }
        if (phoneDigits.length < 8) {
          return c.json(
            {
              error:
                'No pagamento em vale, informe o telefone do cliente (com DDD) para notificar a cobrança.',
              code: 'vale_customer_phone_required',
            },
            400
          );
        }
        sale.customer_name = name;
        sale.customer_phone = phoneDigits;
      }
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
          error: 'Caixa não pertence a esta loja. Feche e abra o caixa novamente nesta conta.',
          force_exit: true,
          reason: 'wrong_store',
        }, 403);
      }
      // Caixa órfão: vincula à loja logada
      if (!cashSession.created_by && user.id) {
        try {
          await admin.from('cash_session').update({ created_by: user.id }).eq('id', session_id).is('created_by', null);
        } catch (_) {}
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
    // Cliente automático antes da RPC também
    try {
      const custId = await upsertCustomer(user.id, {
        name: sale.customer_name || sale.client_name || sale.delivery_person,
        phone: sale.customer_phone || sale.client_phone || sale.delivery_phone,
        email: sale.customer_email || sale.client_email,
        street: sale.delivery_address || sale.customer_address,
        number: sale.delivery_number,
        complement: sale.delivery_complement,
        neighborhood: sale.delivery_neighborhood,
        city: sale.delivery_city,
        state: sale.delivery_state,
        cep: sale.delivery_cep,
        doc: sale.customer_doc || sale.customer_cpf || sale.cpf,
      });
      if (custId) sale.customer_id = custId;
    } catch (e) {
      console.warn('customer upsert pre-rpc', e?.message || e);
    }

    const { data: rpcResult, error: rpcError } = await admin.rpc('finalize_sale', {
      p_items: items,
      p_sale: {
        ...sale,
        operator_name,
        created_by: user.id,
        source: sale.source || 'pdv',
        customer_id: sale.customer_id || null,
      },
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
          customer_name: (sale.customer_name && String(sale.customer_name).trim()) || saleRow.customer_name || null,
          customer_phone: (sale.customer_phone && String(sale.customer_phone).trim()) || saleRow.customer_phone || null,
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
          installment_plan: sale.installment_plan != null ? sale.installment_plan : saleRow.installment_plan,
          vale_interval_days: sale.vale_interval_days != null ? sale.vale_interval_days : saleRow.vale_interval_days,
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
    // Busca produtos da loja + órfãos (sem created_by) para não bloquear venda legítima
    let prodQ = admin.from('product').select('id,name,stock,created_by').in('id', ids);
    const { data: productsRaw } = await prodQ;
    const products = (productsRaw || []).filter(
      (p) => !p.created_by || p.created_by === user.id
    );
    // Vincula órfãos à loja na hora da venda
    for (const p of products) {
      if (!p.created_by) {
        try {
          await admin.from('product').update({ created_by: user.id }).eq('id', p.id).is('created_by', null);
          p.created_by = user.id;
        } catch (_) {}
      }
    }
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

    // Auto-cadastro de cliente (entrega/retirada/balcão) — dedupe por telefone/email
    try {
      const custId = await upsertCustomer(user.id, {
        name: sale.customer_name || sale.client_name || sale.delivery_person,
        phone: sale.customer_phone || sale.client_phone || sale.delivery_phone,
        email: sale.customer_email || sale.client_email,
        street: sale.delivery_address || sale.customer_address,
        number: sale.delivery_number,
        complement: sale.delivery_complement,
        neighborhood: sale.delivery_neighborhood,
        city: sale.delivery_city,
        state: sale.delivery_state,
        cep: sale.delivery_cep,
        doc: sale.customer_doc || sale.customer_cpf || sale.cpf,
      });
      if (custId) sale.customer_id = custId;
    } catch (e) {
      console.warn('customer upsert on finalize', e?.message || e);
    }

    const salePayload = {
      ...sale, items,
      cash_session_id: session_id || sale.cash_session_id,
      client_ref: client_ref || sale.client_ref,
      operator_name,
      status: sale.status || 'concluida',
      source: sale.source || 'pdv',
      created_by: user.id,
      customer_id: sale.customer_id || null,
      customer_name: sale.customer_name || null,
      customer_phone: sale.customer_phone || null,
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



// Soma de faturamento no servidor (evita limite de paginação do front)

// Verifica parcelas de vale próximas/vencidas e cria notificações
functions.post('/check-vale-due', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user?.id) return c.json({ error: 'Unauthorized' }, 401);
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);

    const body = await c.req.json().catch(() => ({}));
    const warnDays = Math.min(Math.max(Number(body.warn_days) || 3, 0), 30);

    const { data: sales } = await admin
      .from('sale')
      .select('id,customer_name,customer_phone,total,installment_plan,payment_method,status,created_by')
      .eq('created_by', user.id)
      .eq('payment_method', 'vale')
      .order('created_at', { ascending: false })
      .limit(500);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let created = 0;

    for (const sale of sales || []) {
      const plan = Array.isArray(sale.installment_plan) ? sale.installment_plan : [];
      for (const p of plan) {
        if (p.paid) continue;
        if (!p.due_date) continue;
        const due = new Date(p.due_date + 'T12:00:00');
        const diffDays = Math.round((due.getTime() - today.getTime()) / 86400000);
        let kind = null;
        if (diffDays < 0) kind = 'vencida';
        else if (diffDays === 0) kind = 'vence_hoje';
        else if (diffDays <= warnDays) kind = 'proxima';
        if (!kind) continue;

        const title =
          kind === 'vencida'
            ? `Vale vencido · parcela ${p.n}`
            : kind === 'vence_hoje'
              ? `Vale vence hoje · parcela ${p.n}`
              : `Vale em ${diffDays} dia(s) · parcela ${p.n}`;
        const phoneLabel = sale.customer_phone
          ? ` · ${String(sale.customer_phone).replace(/\D/g, '')}`
          : '';
        const message = `${sale.customer_name || 'Cliente'}${phoneLabel} · R$ ${Number(p.amount || 0).toFixed(2)} · venc. ${p.due_date} · pedido #${String(sale.id).slice(-6).toUpperCase()}`;

        // evita spam: mesma sale+parcela+kind no dia
        const { data: existing } = await admin
          .from('notification')
          .select('id')
          .eq('created_by', user.id)
          .eq('sale_id', sale.id)
          .eq('type', `vale_${kind}`)
          .ilike('message', `%parcela ${p.n}%`)
          .limit(1);

        if (existing?.length) continue;

        await admin.from('notification').insert({
          title,
          message,
          sale_id: sale.id,
          type: `vale_${kind}`,
          read: false,
          created_by: user.id,
        });
        created += 1;
      }
    }

    return c.json({ ok: true, notifications_created: created, warn_days: warnDays });
  } catch (e) {
    console.error('check-vale-due', e);
    return c.json({ error: e.message || 'failed' }, 500);
  }
});


functions.post('/sales-revenue-summary', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user?.id) return c.json({ error: 'Unauthorized' }, 401);
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);

    const body = await c.req.json().catch(() => ({}));

    // Mês em America/Sao_Paulo
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const nowParts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
    const year = Number(body.year) || Number(nowParts.year);
    const month = body.month != null ? Number(body.month) : Number(nowParts.month) - 1;

    const pad = (n) => String(n).padStart(2, '0');
    const lastDay = new Date(year, month + 1, 0).getDate();
    // bounds BRT
    const start = new Date(`${year}-${pad(month + 1)}-01T00:00:00.000-03:00`);
    const end = new Date(`${year}-${pad(month + 1)}-${pad(lastDay)}T23:59:59.999-03:00`);
    const prevMonth = month === 0 ? 11 : month - 1;
    const prevYear = month === 0 ? year - 1 : year;
    const prevLast = new Date(prevYear, prevMonth + 1, 0).getDate();
    const prevStart = new Date(`${prevYear}-${pad(prevMonth + 1)}-01T00:00:00.000-03:00`);
    const prevEnd = new Date(`${prevYear}-${pad(prevMonth + 1)}-${pad(prevLast)}T23:59:59.999-03:00`);

    const startMs = start.getTime();
    const endMs = end.getTime();
    const prevStartMs = prevStart.getTime();
    const prevEndMs = prevEnd.getTime();

    function saleTime(s) {
      const raw = s.created_at || s.created_date || s.updated_at;
      if (!raw) return null;
      const t = new Date(raw).getTime();
      return Number.isNaN(t) ? null : t;
    }

    function isCounted(s) {
      const st = String(s.status || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
      if (st.includes('cancel')) return false;
      if (st === 'orcamento' || st === 'pedido_aberto') return false;
      return true;
    }

    // Pagina TODAS as vendas da loja até passar o mês anterior (sem early-break agressivo)
    const all = [];
    const pageSize = 1000;
    let offset = 0;
    let pages = 0;
    for (let guard = 0; guard < 100; guard++) {
      const { data, error } = await admin
        .from('sale')
        .select('id,total,status,fee_amount,delivery_fee,created_at,seller_id,seller_name,operator_name,source,delivery_type')
        .eq('created_by', user.id)
        .order('created_at', { ascending: false })
        .range(offset, offset + pageSize - 1);
      if (error) {
        console.warn('sales-revenue-summary', error.message);
        break;
      }
      const rows = data || [];
      pages += 1;
      all.push(...rows);
      if (rows.length < pageSize) break;
      offset += pageSize;
    }

    function sumInRange(fromMs, toMs) {
      let total = 0;
      let count = 0;
      let feeTotal = 0;
      let deliveryTotal = 0;
      let pendingTotal = 0;
      let pendingCount = 0;
      const byStatus = {};
      const bySeller = {};
      let presencial = 0;
      let online = 0;
      for (const s of all) {
        const ts = saleTime(s);
        if (ts == null || ts < fromMs || ts > toMs) continue;
        const stKey = String(s.status || '(vazio)');
        byStatus[stKey] = (byStatus[stKey] || 0) + (Number(s.total) || 0);
        if (isCounted(s)) {
          const amt = Number(s.total) || 0;
          total += amt;
          feeTotal += Number(s.fee_amount) || 0;
          deliveryTotal += Number(s.delivery_fee) || 0;
          count += 1;
          const sName = String(s.seller_name || s.operator_name || '').trim();
          const sid = String(s.seller_id || sName || '_sem_vendedor');
          if (!bySeller[sid]) bySeller[sid] = { seller_id: s.seller_id || null, seller_name: sName || 'Sem vendedor', total: 0, count: 0 };
          bySeller[sid].total += amt;
          bySeller[sid].count += 1;
          if (sName && !bySeller[sid].seller_name) bySeller[sid].seller_name = sName;
          const isOnline = s.source === 'catalog' || s.delivery_type === 'entrega' || s.delivery_type === 'retirada';
          if (isOnline) online += amt; else presencial += amt;
        } else {
          pendingTotal += Number(s.total) || 0;
          pendingCount += 1;
        }
      }
      for (const k of Object.keys(byStatus)) byStatus[k] = Math.round(byStatus[k] * 100) / 100;
      for (const k of Object.keys(bySeller)) {
        bySeller[k].total = Math.round(bySeller[k].total * 100) / 100;
      }
      return {
        total: Math.round(total * 100) / 100,
        count,
        fee_total: Math.round(feeTotal * 100) / 100,
        delivery_total: Math.round(deliveryTotal * 100) / 100,
        pending_total: Math.round(pendingTotal * 100) / 100,
        pending_count: pendingCount,
        by_status: byStatus,
        by_seller: bySeller,
        by_channel: {
          presencial: Math.round(presencial * 100) / 100,
          online: Math.round(online * 100) / 100,
        },
      };
    }

    const current = sumInRange(startMs, endMs);
    const previous = sumInRange(prevStartMs, prevEndMs);
    const pct = previous.total > 0 ? ((current.total - previous.total) / previous.total) * 100 : null;

    return c.json({
      ok: true,
      year,
      month,
      month_start: start.toISOString(),
      month_end: end.toISOString(),
      revenue: current.total,
      sales_count: current.count,
      fee_total: current.fee_total,
      delivery_total: current.delivery_total,
      prev_revenue: previous.total,
      prev_sales_count: previous.count,
      pct_vs_prev: pct,
      pending_catalog: { total: current.pending_total, count: current.pending_count },
      revenue_including_pending: Math.round((current.total + current.pending_total) * 100) / 100,
      scanned: all.length,
      pages,
      by_status: current.by_status || {},
      by_seller: current.by_seller || {},
      by_channel: current.by_channel || { presencial: 0, online: 0 },
    });
  } catch (e) {
    console.error('sales-revenue-summary', e);
    return c.json({ error: e.message || 'failed', ok: false }, 500);
  }
});

// ─── top-products-month: ranking real de produtos vendidos no mês ───────────
// Varre todas as vendas da loja no período e soma qty por product_id (e por nome).
functions.post('/top-products-month', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user?.id) return c.json({ error: 'Unauthorized' }, 401);
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);

    const body = await c.req.json().catch(() => ({}));
    const limit = Math.min(Math.max(Number(body.limit) || 30, 5), 100);

    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const nowParts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
    const year = Number(body.year) || Number(nowParts.year);
    const month = body.month != null ? Number(body.month) : Number(nowParts.month) - 1;
    const pad = (n) => String(n).padStart(2, '0');
    const lastDay = new Date(year, month + 1, 0).getDate();
    const start = new Date(`${year}-${pad(month + 1)}-01T00:00:00.000-03:00`);
    const end = new Date(`${year}-${pad(month + 1)}-${pad(lastDay)}T23:59:59.999-03:00`);
    const startMs = start.getTime();
    const endMs = end.getTime();

    function isCounted(s) {
      const st = String(s.status || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
      if (st.includes('cancel')) return false;
      if (st === 'orcamento' || st === 'pedido_aberto') return false;
      return true;
    }

    const byId = Object.create(null);
    const byName = Object.create(null);
    let salesScanned = 0;
    let itemsCounted = 0;
    const pageSize = 500;
    let offset = 0;

    for (let guard = 0; guard < 80; guard++) {
      const { data, error } = await admin
        .from('sale')
        .select('id,status,created_at,items')
        .eq('created_by', user.id)
        .gte('created_at', start.toISOString())
        .lte('created_at', end.toISOString())
        .order('created_at', { ascending: false })
        .range(offset, offset + pageSize - 1);

      if (error) {
        console.warn('top-products-month page', error.message);
        break;
      }
      const rows = data || [];
      if (!rows.length) break;

      for (const s of rows) {
        salesScanned += 1;
        if (!isCounted(s)) continue;
        const t = s.created_at ? new Date(s.created_at).getTime() : null;
        if (t == null || t < startMs || t > endMs) continue;
        const items = Array.isArray(s.items) ? s.items : [];
        for (const it of items) {
          const qty = Number(it.qty) || Number(it.quantity) || 0;
          if (qty <= 0) continue;
          itemsCounted += 1;
          const pid = it.product_id || it.id || null;
          const name = String(it.name || it.product_name || 'Produto').trim() || 'Produto';
          let rev = Number(it.total);
          if (!(rev > 0)) rev = (Number(it.unit_price) || 0) * qty;
          if (pid) {
            if (!byId[pid]) byId[pid] = { product_id: pid, name, qty: 0, revenue: 0 };
            byId[pid].qty += qty;
            byId[pid].revenue += rev;
            if (name && name !== 'Produto') byId[pid].name = name;
          }
          const nk = name.toLowerCase();
          if (!byName[nk]) byName[nk] = { name, qty: 0, revenue: 0 };
          byName[nk].qty += qty;
          byName[nk].revenue += rev;
        }
      }

      if (rows.length < pageSize) break;
      offset += pageSize;
    }

    const products = Object.values(byId)
      .sort((a, b) => b.qty - a.qty)
      .slice(0, limit)
      .map((p) => ({ product_id: p.product_id, name: p.name, qty: Math.round(p.qty * 1000) / 1000, revenue: Math.round((p.revenue || 0) * 100) / 100 }));

    // Fallback: se nenhuma venda tem product_id, usa agregação por nome
    const byNameList = Object.values(byName)
      .sort((a, b) => b.qty - a.qty)
      .slice(0, limit)
      .map((p) => ({ product_id: null, name: p.name, qty: Math.round(p.qty * 1000) / 1000, revenue: Math.round((p.revenue || 0) * 100) / 100 }));

    return c.json({
      ok: true,
      year,
      month,
      month_start: start.toISOString(),
      month_end: end.toISOString(),
      products: products.length ? products : byNameList,
      sales_scanned: salesScanned,
      items_counted: itemsCounted,
    });
  } catch (e) {
    console.error('top-products-month', e);
    return c.json({ error: e.message || 'failed', ok: false }, 500);
  }
});

// ─── app-bootstrap: 1 request = dados iniciais do app ───────────────────────
// Reduz 6–10 round-trips do front para 1 (bem mais rápido no celular/3G).

functions.post('/app-bootstrap', async (c) => {
  const t0 = Date.now();
  try {
    const user = await requireUser(c);
    if (!user?.id) return c.json({ error: 'Unauthorized' }, 401);
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);

    const body = await c.req.json().catch(() => ({}));
    const productLimit = Math.min(Number(body.product_limit || 500), 2000);
    const saleLimit = Math.min(Number(body.sale_limit || 80), 300);
    const customerLimit = Math.min(Number(body.customer_limit || 100), 500);
    const notifLimit = Math.min(Number(body.notification_limit || 30), 100);

    const uid = user.id;

    const [
      productsRes,
      salesRes,
      customersRes,
      sellersRes,
      settingsRes,
      cashRes,
      notifRes,
      feesRes,
      access,
      allowZero,
    ] = await Promise.all([
      admin.from('product').select('*').eq('created_by', uid).order('created_at', { ascending: false }).limit(productLimit),
      admin.from('sale').select('*').eq('created_by', uid).order('created_at', { ascending: false }).limit(saleLimit),
      admin.from('customer').select('*').eq('created_by', uid).order('created_at', { ascending: false }).limit(customerLimit),
      admin.from('seller').select('*').eq('created_by', uid).order('created_at', { ascending: false }).limit(100),
      admin.from('app_settings').select('*').eq('created_by', uid).order('created_at', { ascending: false }).limit(5),
      admin.from('cash_session').select('*').eq('created_by', uid).order('created_at', { ascending: false }).limit(15),
      admin.from('notification').select('*').eq('created_by', uid).order('created_at', { ascending: false }).limit(notifLimit),
      admin.from('delivery_fee').select('*').eq('created_by', uid).order('created_at', { ascending: false }).limit(100),
      getAccessStatus(uid).catch(() => null),
      getAllowZeroStock().catch(() => false),
    ]);

    const pick = (res) => {
      if (res?.error) {
        console.warn('bootstrap query', res.error.message);
        return [];
      }
      return toBase44Rows(res.data || []);
    };

    let settings = pick(settingsRes);
    // Enriquecer AppSettings uma vez (slug + allow_zero_stock)
    if (settings.length) {
      let catalog_slug = null;
      try {
        catalog_slug = await ensureCatalogSlug(uid, settings[0].company_name || user.company_name || null);
      } catch (_) {}
      const catalog_url = catalog_slug ? buildStorePublicUrl(catalog_slug) : null;
      settings = settings.map((r) => ({
        ...r,
        allow_zero_stock: allowZero === true,
        catalog_slug,
        catalog_url,
      }));
    }

    const openSessions = pick(cashRes).filter((s) => {
      const st = String(s.status || '').toLowerCase();
      return st === 'open' || st === 'aberto';
    });

    const ms = Date.now() - t0;
    return c.json({
      ok: true,
      ms,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        company_name: user.company_name,
        referral_code: user.referral_code,
        catalog_slug: settings[0]?.catalog_slug || user.catalog_slug || null,
        catalog_url: settings[0]?.catalog_url || user.catalog_url || null,
      },
      access: access || null,
      allow_zero_stock: allowZero === true,
      products: pick(productsRes),
      sales: pick(salesRes),
      customers: pick(customersRes),
      sellers: pick(sellersRes),
      app_settings: settings,
      cash_sessions: pick(cashRes),
      open_cash_sessions: openSessions,
      notifications: pick(notifRes),
      delivery_fees: pick(feesRes),
    });
  } catch (error) {
    console.error('app-bootstrap', error);
    return c.json({ error: error.message || 'bootstrap_failed' }, 500);
  }
});

// ─── catch-all ─────────────────────────────────────────────────────────────

functions.post('/:name', async (c) => {
  const name = c.req.param('name');
  const implemented = [
  'open-cash-session','takeover-cash-session','cash-session-heartbeat','list-open-cash-sessions','finalize-sale','delivery-assign','delivery-complete','settle-accountability','courier-balance',
  'release-pdv-reservations','product-inquiry',
  'catalog-data','catalog-checkout','catalog-store-status','catalog-receipt','catalog-history','catalog-account-register','catalog-account-login','catalog-account-update','catalog-expire-pickups','mercadopago-connect','mercadopago-oauth-callback','mercadopago-status','mercadopago-disconnect','catalog-mp-status','catalog-checkout-pix','catalog-checkout-card','catalog-checkout-status','mercadopago-webhook',
  'barcode-lookup','product-name-lookup','enrich-product','save-product','repair-product-ownership','refresh-products-catalog',
  'start-stock-count','stock-count-search','stock-count-apply','sync-pdv-reservations',
  'admin-stats','cleanup-cash-sessions','purge-account','init-help-content',
  'check-vale-due','sales-revenue-summary','top-products-month','app-bootstrap','create-checkout','stripe-webhook','init-subscription','link-referral','subscription-status','get-access-status','access-status','referral-panel','master-code-status','ensure-referral-code','cancel-subscription','resume-subscription',
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
