/**
 * Camada de integração entre módulos:
 * Estoque → Catálogo → Pedidos/Entrega → Caixa → Prestação de Contas
 *
 * Fonte única da verdade:
 * - product ………… estoque / catálogo
 * - sale …………… pedidos (PDV + catálogo + entrega)
 * - cash_session … caixas abertos
 * - cash_movement … sangrias/suprimentos/entrada de dinheiro (prestação)
 * - courier_closing … fechamentos de prestação de contas
 */
import { Hono } from 'hono';
import { admin } from './db.js';
import { logOperation, requireUser, toBase44Row, toBase44Rows } from './helpers.js';

const integration = new Hono();

/** Retorna o caixa aberto mais recente (ou null). */
export async function getOpenCashSession() {
  if (!admin) return null;
  const { data } = await admin
    .from('cash_session')
    .select('*')
    .eq('status', 'aberto')
    .order('created_at', { ascending: false })
    .limit(1);
  return data?.[0] || null;
}

/**
 * Registra movimentação no caixa da loja (uma única fonte).
 * Tipos: venda | sangria | suprimento | prestacao_entregador | taxa_entrega
 */
export async function registerCashMovement({
  cash_session_id,
  type,
  amount,
  reason = '',
  sale_id = null,
  operator_name = '',
}) {
  if (!admin || !cash_session_id || !amount) return null;
  const payload = {
    cash_session_id,
    type,
    amount: Number(amount) || 0,
    reason: String(reason || '').slice(0, 500),
  };
  // Campos opcionais se existirem no schema
  if (sale_id) payload.sale_id = sale_id;
  if (operator_name) payload.operator_name = operator_name;

  const { data, error } = await admin.from('cash_movement').insert(payload).select().single();
  if (error) {
    // Schema pode não ter sale_id/operator_name — tenta versão mínima
    if (String(error.message || '').includes('column')) {
      const { data: d2, error: e2 } = await admin
        .from('cash_movement')
        .insert({
          cash_session_id,
          type,
          amount: Number(amount) || 0,
          reason: String(reason || '').slice(0, 500),
        })
        .select()
        .single();
      if (e2) throw e2;
      return d2;
    }
    throw error;
  }
  return data;
}

/**
 * Atribui entregador a um pedido de entrega e avança status.
 */

/**
 * Efeitos colaterais ao cancelar uma venda concluída:
 * - devolve estoque dos itens
 * - registra estorno no caixa (valor negativo) se houver sessão
 * Idempotente: se já estava cancelada, não faz nada de estoque/caixa de novo
 * (caller deve checar status anterior).
 */
export async function applySaleCancellationSideEffects(sale, { operator_name = '' } = {}) {
  if (!admin || !sale) return { stock_restored: 0, cash_reversed: false };

  const prev = String(sale.status || '').toLowerCase();
  // Só devolve estoque se a venda tinha consumido estoque (concluída)
  const shouldRestoreStock = prev === 'concluida' || prev === 'concluido';

  let stock_restored = 0;
  if (shouldRestoreStock) {
    for (const it of sale.items || []) {
      const pid = it.product_id || it.productId;
      const qty = Number(it.qty || it.quantity || 0);
      if (!pid || qty <= 0) continue;
      try {
        const { data: p } = await admin.from('product').select('id,stock').eq('id', pid).maybeSingle();
        if (!p) continue;
        const next = (Number(p.stock) || 0) + qty;
        await admin.from('product').update({ stock: next }).eq('id', pid);
        stock_restored += qty;
      } catch (e) {
        console.warn('restore stock on cancel', pid, e?.message || e);
      }
    }
  }

  let cash_reversed = false;
  const sessionId = sale.cash_session_id;
  const total = Number(sale.total) || 0;
  if (sessionId && total > 0 && shouldRestoreStock) {
    try {
      await registerCashMovement({
        cash_session_id: sessionId,
        type: 'venda',
        amount: -Math.abs(total),
        reason: `Estorno cancelamento #${String(sale.id || '').slice(-6).toUpperCase()}`,
        sale_id: sale.id || null,
        operator_name: operator_name || sale.operator_name || '',
      });
      cash_reversed = true;
    } catch (e) {
      console.warn('cash reverse on cancel', e?.message || e);
    }
  }

  return { stock_restored, cash_reversed };
}


integration.post('/delivery-assign', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);

    const body = await c.req.json().catch(() => ({}));
    const { sale_id, delivery_person, courier_id } = body;
    if (!sale_id) return c.json({ error: 'sale_id obrigatório' }, 400);
    if (!delivery_person && !courier_id) {
      return c.json({ error: 'Informe o entregador' }, 400);
    }

    const { data: sale } = await admin.from('sale').select('*').eq('id', sale_id).maybeSingle();
    if (!sale) return c.json({ error: 'Pedido não encontrado' }, 404);
    if (sale.delivery_type !== 'entrega') {
      return c.json({ error: 'Pedido não é de entrega' }, 400);
    }

    let personName = delivery_person || '';
    if (courier_id && !personName) {
      const { data: courier } = await admin.from('courier').select('*').eq('id', courier_id).maybeSingle();
      if (!courier) return c.json({ error: 'Entregador não encontrado' }, 404);
      personName = courier.name;
    }

    const updates = {
      delivery_person: personName,
      delivery_status:
        !sale.delivery_status || sale.delivery_status === 'aguardando'
          ? 'em_rota'
          : sale.delivery_status,
    };

    const { data: updated, error } = await admin
      .from('sale')
      .update(updates)
      .eq('id', sale_id)
      .select()
      .single();
    if (error) return c.json({ error: error.message }, 500);

    await logOperation({
      type: 'delivery_assign',
      level: 'info',
      description: `Pedido ${sale_id} atribuído a ${personName}`,
      operator_name: user.full_name || user.email || '',
      sale_id,
    });

    return c.json({ sale: toBase44Row(updated), success: true });
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

/**
 * Marca entrega como concluída.
 * - Se pagamento em dinheiro e ainda não confirmado → aguarda prestação de contas
 * - Caso contrário → conclui e vincula ao caixa aberto (se houver)
 * Estoque já foi baixado no checkout do catálogo / finalize-sale do PDV.
 */
integration.post('/delivery-complete', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);

    const body = await c.req.json().catch(() => ({}));
    const { sale_id, cash_received, change_amount } = body;
    if (!sale_id) return c.json({ error: 'sale_id obrigatório' }, 400);

    const { data: sale } = await admin.from('sale').select('*').eq('id', sale_id).maybeSingle();
    if (!sale) return c.json({ error: 'Pedido não encontrado' }, 404);

    const isCash =
      sale.payment_method === 'dinheiro' ||
      (Array.isArray(sale.payments) && sale.payments.some((p) => p.method === 'dinheiro'));

    const updates = {
      delivery_status: 'entregue',
    };

    if (cash_received != null) {
      updates.cash_received = Number(cash_received) || 0;
    } else if (isCash && body.cash_change_for != null) {
      updates.cash_received = Number(body.cash_change_for) || 0;
    }
    if (change_amount != null) {
      updates.change_amount = Number(change_amount) || 0;
    } else if (updates.cash_received != null && Number(sale.total) > 0) {
      updates.change_amount = Math.max(0, Number(updates.cash_received) - Number(sale.total));
    }
    // Garante que o valor físico recebido não seja perdido
    if (isCash && updates.cash_received == null && sale.cash_received == null) {
      // não inventa valor; front deve enviar cash_received
    }

    // Dinheiro com entregador → prestação de contas
    if (isCash && sale.cash_confirmed !== true) {
      updates.delivery_status = 'aguardando_prestacao_contas';
      updates.status = sale.status === 'orcamento' ? 'orcamento' : sale.status;
    } else {
      updates.status = 'concluida';
      updates.cash_confirmed = true;
      // Vincula ao caixa aberto se ainda não tiver
      if (!sale.cash_session_id) {
        const session = await getOpenCashSession();
        if (session) updates.cash_session_id = session.id;
      }
    }

    if (!sale.delivery_person && body.delivery_person) {
      updates.delivery_person = body.delivery_person;
    }

    const { data: updated, error } = await admin
      .from('sale')
      .update(updates)
      .eq('id', sale_id)
      .select()
      .single();
    if (error) return c.json({ error: error.message }, 500);

    // Se já concluiu (não dinheiro pendente), registra no caixa
    if (updated.status === 'concluida' && updated.cash_session_id) {
      try {
        await registerCashMovement({
          cash_session_id: updated.cash_session_id,
          type: 'venda',
          amount: Number(updated.total) || 0,
          reason: `Pedido entrega #${String(sale_id).slice(-6).toUpperCase()} · ${updated.customer_name || ''}`,
          sale_id,
          operator_name: user.full_name || user.email || '',
        });
      } catch (e) {
        console.warn('cash movement on delivery-complete', e.message);
      }
    }

    await logOperation({
      type: 'delivery_complete',
      level: 'info',
      description: `Entrega ${sale_id} → ${updated.delivery_status}`,
      operator_name: user.full_name || user.email || '',
      sale_id,
      cash_session_id: updated.cash_session_id || '',
    });

    return c.json({ sale: toBase44Row(updated), success: true });
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

/**
 * Fecha prestação de contas de um entregador.
 * - Marca vendas como settled + cash_confirmed
 * - Cria courier_closing
 * - Registra entrada de dinheiro no caixa aberto da loja
 */
integration.post('/settle-accountability', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);

    const body = await c.req.json().catch(() => ({}));
    const { courier_name, sale_ids } = body;
    if (!courier_name) return c.json({ error: 'courier_name obrigatório' }, 400);
    if (!Array.isArray(sale_ids) || !sale_ids.length) {
      return c.json({ error: 'sale_ids obrigatório' }, 400);
    }

    const { data: sales, error: sErr } = await admin
      .from('sale')
      .select('*')
      .in('id', sale_ids);
    if (sErr) return c.json({ error: sErr.message }, 500);
    if (!sales?.length) return c.json({ error: 'Nenhuma venda encontrada' }, 404);

    const now = new Date().toISOString();
    const closedBy = user.full_name || user.email || 'Sistema';

    // Totais
    let totalCash = 0;
    let totalChange = 0;
    let totalFees = 0;
    for (const s of sales) {
      totalFees += Number(s.delivery_fee) || 0;
      if (s.payment_method === 'dinheiro') {
        const received = Number(s.cash_received || s.cash_change_for || s.total) || 0;
        totalCash += received;
        if (Number(s.change_amount) > 0) totalChange += Number(s.change_amount);
        else if (received > 0) totalChange += Math.max(0, received - (Number(s.total) || 0));
      } else if (s.payment_method === 'misto' && Array.isArray(s.payments)) {
        totalCash += s.payments
          .filter((p) => p.method === 'dinheiro')
          .reduce((acc, p) => acc + (Number(p.amount) || 0), 0);
      }
    }
    // Valor líquido que o entregador devolve à loja ≈ totalCash - totalChange
    // (troco já ficou com o cliente). Taxa de entrega pode ou não estar no total.
    const netToStore = Math.max(0, totalCash - totalChange);

    const session = await getOpenCashSession();

    // Atualiza cada venda
    for (const s of sales) {
      const updates = {
        accountability_settled: true,
        cash_confirmed: true,
        cash_confirmed_at: now,
        cash_confirmed_by: closedBy,
        delivery_fee_paid: true,
        delivery_fee_paid_at: now,
        delivery_status: 'entregue',
        status: 'concluida',
      };
      if (!s.cash_session_id && session) updates.cash_session_id = session.id;

      await admin.from('sale').update(updates).eq('id', s.id);
    }

    // Histórico do entregador
    const closingPayload = {
      courier_name,
      deliveries_count: sales.length,
      total_cash_amount: totalCash,
      total_received: totalCash,
      total_change: totalChange,
      total_delivery_fees: totalFees,
      sale_ids,
      closed_by: closedBy,
      closed_at: now,
    };
    const { data: closing, error: cErr } = await admin
      .from('courier_closing')
      .insert(closingPayload)
      .select()
      .single();
    if (cErr) {
      console.error('courier_closing insert', cErr);
      // Continua mesmo se tabela tiver schema diferente
    }

    // Entrada no caixa da loja (elimina lançamento manual duplicado)
    let movement = null;
    if (session && netToStore > 0) {
      try {
        movement = await registerCashMovement({
          cash_session_id: session.id,
          type: 'prestacao_entregador',
          amount: netToStore,
          reason: `Prestação de contas · ${courier_name} · ${sales.length} entrega(s) · R$ ${netToStore.toFixed(2)}`,
          operator_name: closedBy,
        });
      } catch (e) {
        // Fallback: tipo 'suprimento' se 'prestacao_entregador' não for aceito
        try {
          movement = await registerCashMovement({
            cash_session_id: session.id,
            type: 'suprimento',
            amount: netToStore,
            reason: `Prestação de contas · ${courier_name} · ${sales.length} entrega(s)`,
            operator_name: closedBy,
          });
        } catch (e2) {
          console.error('cash movement on settle', e2.message);
        }
      }
    }

    await logOperation({
      type: 'accountability_settle',
      level: 'info',
      description: `Prestação ${courier_name}: R$ ${netToStore.toFixed(2)} · ${sales.length} pedidos`,
      operator_name: closedBy,
      cash_session_id: session?.id || '',
    });

    return c.json({
      success: true,
      closing: closing ? toBase44Row(closing) : null,
      movement: movement ? toBase44Row(movement) : null,
      totals: {
        total_cash: totalCash,
        total_change: totalChange,
        total_fees: totalFees,
        net_to_store: netToStore,
        sales_count: sales.length,
        cash_session_id: session?.id || null,
      },
    });
  } catch (error) {
    console.error('settle-accountability', error);
    return c.json({ error: error.message }, 500);
  }
});

/**
 * Resumo integrado de um entregador (saldo em posse, já entregue, etc.)
 */
integration.post('/courier-balance', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);

    const body = await c.req.json().catch(() => ({}));
    const courier_name = body.courier_name;
    if (!courier_name) return c.json({ error: 'courier_name obrigatório' }, 400);

    const { data: pending } = await admin
      .from('sale')
      .select('*')
      .eq('delivery_person', courier_name)
      .eq('accountability_settled', false)
      .eq('delivery_type', 'entrega')
      .limit(500);

    const { data: closings } = await admin
      .from('courier_closing')
      .select('*')
      .eq('courier_name', courier_name)
      .order('created_at', { ascending: false })
      .limit(50);

    let heldCash = 0; // valor físico recebido do cliente (não desconta troco)
    let heldNet = 0;  // após troco (o que sobra para a loja)
    let totalDeliveryFees = 0;
    for (const s of pending || []) {
      totalDeliveryFees += Number(s.delivery_fee) || 0;
      const isCash =
        s.payment_method === 'dinheiro' ||
        (Array.isArray(s.payments) && s.payments.some((p) => p.method === 'dinheiro'));
      if (!isCash) continue;
      let received = Number(s.cash_received || s.cash_change_for) || 0;
      if (!received && s.payment_method === 'misto' && Array.isArray(s.payments)) {
        received = s.payments.filter((p) => p.method === 'dinheiro').reduce((a, p) => a + (Number(p.amount) || 0), 0);
      }
      if (!received) received = Number(s.total) || 0;
      const change = Number(s.change_amount) || 0;
      heldCash += received;
      heldNet += Math.max(0, received - change);
    }

    const totalSettled = (closings || []).reduce(
      (acc, cl) => acc + (Number(cl.total_received || cl.total_cash_amount) || 0),
      0
    );

    return c.json({
      courier_name,
      pending_sales: toBase44Rows(pending || []),
      pending_count: (pending || []).length,
      cash_held_by_courier: heldCash,
      cash_held_net_after_change: heldNet,
      total_delivery_fees_pending: Math.round(totalDeliveryFees * 100) / 100,
      closings: toBase44Rows(closings || []),
      total_settled_historical: totalSettled,
    });
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});


/**
 * Cancela pedido em aberto (PDV salvo ou catálogo orçamento) e devolve estoque.
 */
integration.post('/cancel-open-order', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);

    const body = await c.req.json().catch(() => ({}));
    const sale_id = body.sale_id || body.id;
    if (!sale_id) return c.json({ error: 'sale_id obrigatório' }, 400);

    const { data: sale } = await admin.from('sale').select('*').eq('id', sale_id).maybeSingle();
    if (!sale) return c.json({ error: 'Pedido não encontrado' }, 404);
    if (sale.created_by && user.id && sale.created_by !== user.id) {
      // multi-tenant: allow if same store owner
      // if strict, check created_by
    }

    const st = String(sale.status || '').toLowerCase();
    if (st === 'cancelado' || st === 'cancelada') {
      return c.json({ ok: true, already: true });
    }
    // Só cancela abertos / orçamento / aguardando (não vendas concluídas sem fluxo de cancelamento formal)
    const openStatuses = ['pedido_aberto', 'orcamento', 'orçamento', 'aguardando'];
    if (!openStatuses.includes(st) && sale.source !== 'catalog') {
      // ainda permite se delivery_status aguardando
      if (String(sale.delivery_status || '').toLowerCase() !== 'aguardando') {
        return c.json({ error: 'Este pedido não pode ser cancelado por este fluxo.' }, 400);
      }
    }

    // Devolve estoque dos itens
    for (const it of sale.items || []) {
      if (!it.product_id || !it.qty) continue;
      try {
        const { data: p } = await admin.from('product').select('id,stock').eq('id', it.product_id).maybeSingle();
        if (p) {
          await admin.from('product').update({
            stock: (Number(p.stock) || 0) + Number(it.qty),
          }).eq('id', it.product_id);
        }
      } catch (e) {
        console.warn('cancel-open-order stock', e.message);
      }
    }

    const { data: updated, error } = await admin
      .from('sale')
      .update({
        status: 'cancelado',
        pickup_status: sale.pickup_status === 'aguardando' ? 'cancelado' : sale.pickup_status,
        delivery_status: sale.delivery_status === 'aguardando' ? 'cancelado' : sale.delivery_status,
        cancelled_at: new Date().toISOString(),
        cancelled_by: user.full_name || user.email || user.id,
      })
      .eq('id', sale_id)
      .select()
      .maybeSingle();
    if (error) return c.json({ error: error.message }, 500);

    try {
      await logOperation({
        type: 'order_cancel',
        level: 'info',
        description: `Pedido cancelado #${String(sale_id).slice(-6).toUpperCase()}`,
        operator_name: user.full_name || user.email || '',
        sale_id,
      });
    } catch (_) {}

    return c.json({ ok: true, sale: toBase44Row(updated || { id: sale_id, status: 'cancelado' }) });
  } catch (e) {
    console.error('cancel-open-order', e);
    return c.json({ error: e.message || 'failed' }, 500);
  }
});



/**
 * Edita venda concluída com ajuste de estoque e totais.
 * body: { sale_id, items, discount, notes, payment_method, reason }
 */
integration.post('/edit-concluded-sale', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);

    const body = await c.req.json().catch(() => ({}));
    const sale_id = body.sale_id || body.id;
    if (!sale_id) return c.json({ error: 'sale_id obrigatório' }, 400);
    if (!body.reason || !String(body.reason).trim()) {
      return c.json({ error: 'Informe o motivo da alteração' }, 400);
    }

    const { data: sale } = await admin.from('sale').select('*').eq('id', sale_id).maybeSingle();
    if (!sale) return c.json({ error: 'Venda não encontrada' }, 404);

    const oldItems = Array.isArray(sale.items) ? sale.items : [];
    const newItems = Array.isArray(body.items) ? body.items : oldItems;

    // mapa qty por produto
    const oldMap = {};
    for (const it of oldItems) {
      if (!it.product_id) continue;
      oldMap[it.product_id] = (oldMap[it.product_id] || 0) + (Number(it.qty) || 0);
    }
    const newMap = {};
    for (const it of newItems) {
      if (!it.product_id) continue;
      newMap[it.product_id] = (newMap[it.product_id] || 0) + (Number(it.qty) || 0);
    }

    const allIds = new Set([...Object.keys(oldMap), ...Object.keys(newMap)]);
    for (const pid of allIds) {
      const delta = (newMap[pid] || 0) - (oldMap[pid] || 0);
      if (delta === 0) continue;
      const { data: prod } = await admin.from('product').select('id,stock,name').eq('id', pid).maybeSingle();
      if (!prod) continue;
      // delta > 0 = mais vendido = baixa estoque; delta < 0 = devolve
      const nextStock = (Number(prod.stock) || 0) - delta;
      await admin.from('product').update({ stock: nextStock }).eq('id', pid);
    }

    let subtotal = 0;
    const normalized = newItems.map((it) => {
      const qty = Number(it.qty) || 0;
      const unit = Number(it.unit_price) || 0;
      const total = Math.round(qty * unit * 100) / 100;
      subtotal += total;
      return {
        product_id: it.product_id,
        name: it.name || '',
        qty,
        unit_price: unit,
        total,
        discount: Number(it.discount) || 0,
      };
    });
    subtotal = Math.round(subtotal * 100) / 100;
    const discount = Number(body.discount != null ? body.discount : sale.discount) || 0;
    const deliveryFee = Number(sale.delivery_fee) || 0;
    const feeAmount = Number(body.fee_amount != null ? body.fee_amount : sale.fee_amount) || 0;
    const total = Math.round((subtotal - discount + deliveryFee + feeAmount) * 100) / 100;

    const updates = {
      items: normalized,
      subtotal,
      discount,
      total,
      notes: body.notes != null ? body.notes : sale.notes,
    };
    if (body.payment_method) updates.payment_method = body.payment_method;
    if (body.payments) updates.payments = body.payments;
    if (body.installment_plan) updates.installment_plan = body.installment_plan;

    const { data: updated, error } = await admin
      .from('sale')
      .update(updates)
      .eq('id', sale_id)
      .select()
      .maybeSingle();
    if (error) return c.json({ error: error.message }, 500);

    try {
      await admin.from('sale_audit_log').insert({
        sale_id,
        user_name: user.full_name || user.email || user.id,
        action: 'edicao',
        reason: String(body.reason).trim(),
        previous_values: JSON.stringify({
          items: oldItems,
          discount: sale.discount,
          total: sale.total,
          payment_method: sale.payment_method,
        }),
        new_values: JSON.stringify({
          items: normalized,
          discount,
          total,
          payment_method: updates.payment_method || sale.payment_method,
        }),
        created_by: user.id,
      });
    } catch (e) {
      console.warn('sale_audit_log', e.message);
    }

    await logOperation({
      type: 'sale_edit',
      level: 'info',
      description: `Venda editada #${String(sale_id).slice(-6).toUpperCase()}: ${body.reason}`,
      operator_name: user.full_name || user.email || '',
      sale_id,
    });

    return c.json({ ok: true, sale: toBase44Row(updated) });
  } catch (e) {
    console.error('edit-concluded-sale', e);
    return c.json({ error: e.message || 'failed' }, 500);
  }
});

/**
 * Baixa de vale por valor (saldo), não por parcela de calendário.
 * body: { sale_id, amount }  ou legado { sale_id, parcel_n }
 */

function valeRemaining(sale) {
  const total = Number(sale.total || 0);
  const raw = sale.installment_plan;
  if (raw && !Array.isArray(raw) && typeof raw === 'object') {
    const pays = Array.isArray(raw.payments) ? raw.payments : [];
    const paid = pays.reduce((s, p) => s + Number(p.amount || 0), 0);
    return Math.round((Number(raw.total || total) - paid) * 100) / 100;
  }
  if (Array.isArray(raw)) {
    const paid = raw.filter((p) => p.paid).reduce((s, p) => s + Number(p.amount || 0), 0);
    return Math.round((total - paid) * 100) / 100;
  }
  return Math.round(total * 100) / 100;
}

function valeIsVale(sale) {
  const pm = String(sale.payment_method || '').toLowerCase();
  if (pm.includes('vale')) return true;
  const pays = Array.isArray(sale.payments) ? sale.payments : [];
  if (pays.some((p) => String(p?.method || p?.payment_method || '').toLowerCase().includes('vale'))) return true;
  if (sale.installment_plan) return true;
  return false;
}

integration.post('/vale-open', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user?.id) return c.json({ error: 'Unauthorized' }, 401);
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);
    const { data, error } = await admin
      .from('sale')
      .select('id,customer_name,customer_phone,total,installment_plan,payment_method,payments,status,created_at,created_by')
      .eq('created_by', user.id)
      .order('created_at', { ascending: false })
      .limit(800);
    if (error) return c.json({ error: error.message }, 500);
    const now = Date.now();
    const rows = [];
    for (const sale of data || []) {
      if (String(sale.status || '') === 'cancelada') continue;
      if (!valeIsVale(sale)) continue;
      const remaining = valeRemaining(sale);
      if (!(remaining > 0.009)) continue;
      const plan = sale.installment_plan;
      const pays = plan && !Array.isArray(plan) ? (plan.payments || []) : (Array.isArray(plan) ? plan.filter((p) => p.paid) : []);
      const lastAt = pays.map((p) => p.at || p.paid_at).filter(Boolean).sort().slice(-1)[0] || sale.created_at;
      const days = Math.floor((now - new Date(lastAt).getTime()) / 86400000);
      rows.push({
        id: sale.id,
        customer_name: sale.customer_name || 'Cliente',
        customer_phone: sale.customer_phone || '',
        total: Number(sale.total || 0),
        remaining,
        due_label: 'sem data definida',
        last_activity: lastAt,
        days_without_payment: days,
        stale: days >= 30,
      });
    }
    return c.json({ ok: true, vales: rows });
  } catch (e) {
    return c.json({ error: e.message || 'failed' }, 500);
  }
});

integration.post('/mark-vale-paid', async (c) => {

  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);

    const body = await c.req.json().catch(() => ({}));
    const sale_id = body.sale_id;
    if (!sale_id) return c.json({ error: 'sale_id obrigatório' }, 400);

    const { data: sale } = await admin.from('sale').select('*').eq('id', sale_id).maybeSingle();
    if (!sale) return c.json({ error: 'Venda não encontrada' }, 404);
    if (sale.created_by && user.id && sale.created_by !== user.id) {
      return c.json({ error: 'forbidden' }, 403);
    }

    const total = Number(sale.total || 0);
    let plan = sale.installment_plan;

    const asBalance = (raw) => {
      if (raw && !Array.isArray(raw) && typeof raw === 'object') {
        const payments = Array.isArray(raw.payments) ? raw.payments : [];
        const paid = payments.reduce((s, p) => s + Number(p.amount || 0), 0);
        return {
          mode: 'balance',
          total: Number(raw.total || total),
          payments,
          paid_total: Math.round(paid * 100) / 100,
          remaining: Math.round((Number(raw.total || total) - paid) * 100) / 100,
        };
      }
      const parcels = Array.isArray(raw) ? raw : [];
      const payments = parcels.filter((p) => p.paid).map((p) => ({
        amount: Number(p.amount || 0),
        at: p.paid_at || null,
        by: p.paid_by || null,
        from_parcel: p.n,
      }));
      const paid = payments.reduce((s, p) => s + Number(p.amount || 0), 0);
      return {
        mode: 'balance',
        total,
        payments,
        paid_total: Math.round(paid * 100) / 100,
        remaining: Math.round((total - paid) * 100) / 100,
      };
    };

    plan = asBalance(plan);

    if (body.parcel_n && !(Number(body.amount) > 0)) {
      const parcels = Array.isArray(sale.installment_plan) ? sale.installment_plan : [];
      const found = parcels.find((p) => Number(p.n) === Number(body.parcel_n));
      if (found && !found.paid) body.amount = Number(found.amount || 0);
    }

    const pay = Math.round(Number(body.amount || 0) * 100) / 100;
    if (!(pay > 0)) return c.json({ error: 'Informe o valor recebido.' }, 400);
    if (pay > plan.remaining + 0.009) {
      return c.json({ error: `Valor maior que o saldo (R$ ${plan.remaining.toFixed(2)}).` }, 400);
    }

    plan.payments.push({
      amount: pay,
      at: new Date().toISOString(),
      by: user.full_name || user.email || user.id,
    });
    plan.paid_total = Math.round((plan.paid_total + pay) * 100) / 100;
    plan.remaining = Math.round((plan.total - plan.paid_total) * 100) / 100;

    const { data: updated, error } = await admin
      .from('sale')
      .update({ installment_plan: plan })
      .eq('id', sale_id)
      .select()
      .maybeSingle();
    if (error) return c.json({ error: error.message }, 500);

    return c.json({ ok: true, sale: toBase44Row(updated), plan });
  } catch (e) {
    return c.json({ error: e.message || 'failed' }, 500);
  }
});


export default integration;
export { integration };
