import { Hono } from 'hono';
import { admin } from './db.js';
import { buildReservationMap, computeCatalogAvailable, getAllowZeroStock, getDeliveryPauseStatus } from './helpers.js';

const catalog = new Hono();

catalog.post('/catalog-data', async (c) => {
  try {
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);

    const { data: settingsList } = await admin
      .from('app_settings').select('*').order('created_at', { ascending: false }).limit(1);
    const cfg = settingsList?.[0];
    const maxQtyLimit = Number(cfg?.catalog_max_qty_per_product ?? 10) || 10;

    if (cfg && cfg.catalog_enabled === false) {
      return c.json({
        enabled: false, products: [], fees: [], categories: [], brands: [], sellers: [],
        whatsapp: cfg?.catalog_whatsapp || '',
      });
    }

    const reserve = Math.max(0, Number(cfg?.catalog_stock_reserve ?? 0) || 0);
    const reservationMap = await buildReservationMap();
    const allowZeroStock = await getAllowZeroStock();

    // Isola o catálogo pela loja dona das configurações
    const storeOwnerId = cfg?.created_by || null;

    let productsQuery = admin
      .from('product')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(500);
    if (storeOwnerId) {
      productsQuery = productsQuery.eq('created_by', storeOwnerId);
    }
    let { data: products } = await productsQuery;

    // Fallback: se a loja dona das settings não tem produtos, mostra todos
    // (evita catálogo vazio quando created_by dos produtos difere do app_settings)
    if (storeOwnerId && (!products || products.length === 0)) {
      const { data: allProducts } = await admin
        .from('product')
        .select('*')
        .order('updated_at', { ascending: false })
        .limit(500);
      products = allProducts;
    }

    const available = (products || [])
      .filter((p) => p.active !== false && p.show_in_catalog === true)
      .map((p) => {
        const reserved = reservationMap[p.id] || 0;
        const catalogStock = computeCatalogAvailable(p.stock, reserve, reserved);
        const maxQty = allowZeroStock
          ? Math.max(maxQtyLimit, catalogStock)
          : Math.max(0, Math.min(catalogStock, maxQtyLimit));
        return {
          id: p.id,
          name: p.name,
          description: p.description || '',
          sale_price: p.sale_price || 0,
          category: p.category || '',
          brand: p.brand || '',
          image_url: p.image_url || '',
          barcode: p.barcode || '',
          code: p.code || '',
          available: allowZeroStock || catalogStock > 0,
          max_qty: maxQty,
        };
      });

    const categories = [...new Set(available.map((p) => p.category).filter(Boolean))].sort();
    const brands = [...new Set(available.map((p) => p.brand).filter(Boolean))].sort();

    let feesQuery = admin.from('delivery_fee').select('*').eq('active', true);
    if (storeOwnerId) feesQuery = feesQuery.eq('created_by', storeOwnerId);
    const { data: fees } = await feesQuery;

    let sellersQuery = admin
      .from('seller').select('id,name').eq('status', 'ativo').order('created_at', { ascending: false }).limit(200);
    if (storeOwnerId) sellersQuery = sellersQuery.eq('created_by', storeOwnerId);
    const { data: sellers } = await sellersQuery;

    const { data: admins } = await admin.from('profiles').select('*').eq('role', 'admin').limit(1);
    const adminUser = admins?.[0];

    let sessionsQuery = admin.from('cash_session').select('id,created_by').eq('status', 'aberto').limit(5);
    if (storeOwnerId) sessionsQuery = sessionsQuery.eq('created_by', storeOwnerId);
    const { data: openSessions } = await sessionsQuery;


    const pauseStatus = getDeliveryPauseStatus(cfg);

    return c.json({
      enabled: true,
      products: available,
      categories,
      brands,
      fees: (fees || []).map((f) => ({
        id: f.id, neighborhood: f.neighborhood, fee: f.fee, delivery_time: f.delivery_time || '',
      })),
      sellers: (sellers || []).map((s) => ({ id: s.id, name: s.name })),
      whatsapp: cfg?.catalog_whatsapp || '',
      card_rates: cfg?.card_installment_rates || [],
      max_qty_per_product: maxQtyLimit,
      store_open: (openSessions || []).length > 0,
      delivery_paused: pauseStatus.paused,
      delivery_pause_message: pauseStatus.message,
      company: {
        company_name: cfg?.company_name || adminUser?.company_name || '',
        company_logo_url: cfg?.company_logo_url || '',
        brand_color: cfg?.brand_color || '#4f46e5',
        catalog_slogan: cfg?.catalog_slogan || 'Compre online com praticidade e segurança',
        company_cnpj: adminUser?.company_cnpj || '',
        company_phone: adminUser?.company_phone || '',
        referral_code: adminUser?.referral_code || '',
      },
    });

  } catch (error) {
    console.error('catalog-data error', error);
    return c.json({
      enabled: false, products: [], fees: [], categories: [], brands: [], sellers: [],
      error: error.message,
    }, 500);
  }
});

catalog.post('/catalog-store-status', async (c) => {
  try {
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);
    const { data: openSessions } = await admin
      .from('cash_session').select('id').eq('status', 'aberto').limit(1);
    const { data: settingsList } = await admin
      .from('app_settings').select('*').order('created_at', { ascending: false }).limit(1);
    const cfg = settingsList?.[0];
    const pauseStatus = getDeliveryPauseStatus(cfg);
    return c.json({
      store_open: (openSessions || []).length > 0,
      catalog_enabled: cfg?.catalog_enabled !== false,
      whatsapp: cfg?.catalog_whatsapp || '',
      delivery_paused: pauseStatus.paused,
      delivery_pause_message: pauseStatus.message,
    });
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});


catalog.post('/catalog-checkout', async (c) => {
  try {
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);
    const body = await c.req.json().catch(() => ({}));
    const items = Array.isArray(body.items) ? body.items : [];
    const customer = body.customer || {};
    const deliveryType = body.delivery_type === 'entrega' ? 'entrega' : 'retirada';

    if (!items.length) return c.json({ error: 'Carrinho vazio' }, 400);
    if (!customer.name || !customer.phone) return c.json({ error: 'Nome e telefone são obrigatórios' }, 400);
    if (deliveryType === 'entrega') {
      if (!body.cep || !body.street || !body.number || !body.neighborhood) {
        return c.json({ error: 'Endereço incompleto: CEP, rua, número e bairro são obrigatórios para entrega' }, 400);
      }
    }
    if (!body.seller_id) return c.json({ error: 'Selecione o vendedor' }, 400);

    const { data: settingsList } = await admin
      .from('app_settings').select('*').order('created_at', { ascending: false }).limit(1);
    const settings = settingsList?.[0] || null;
    const storeOwnerId = settings?.created_by || null;

    const { data: seller } = await admin.from('seller').select('*').eq('id', body.seller_id).maybeSingle();
    if (!seller || seller.status !== 'ativo') {
      return c.json({ error: 'Vendedor inválido ou inativo' }, 400);
    }
    // Vendedor deve pertencer à mesma loja
    if (storeOwnerId && seller.created_by && seller.created_by !== storeOwnerId) {
      return c.json({ error: 'Vendedor inválido ou inativo' }, 400);
    }

    let sessionsQuery = admin.from('cash_session').select('id,created_by').eq('status', 'aberto').limit(5);
    if (storeOwnerId) sessionsQuery = sessionsQuery.eq('created_by', storeOwnerId);
    const { data: openSessions } = await sessionsQuery;
    if (!openSessions?.length) {
      return c.json({
        error: 'Nossa loja está fechada no momento. Você pode montar seu carrinho normalmente e finalizar seu pedido assim que houver um caixa aberto. Agradecemos sua compreensão!',
        store_closed: true,
      }, 409);
    }


    // Bloqueio de entrega no intervalo do entregador
    if (deliveryType === 'entrega') {
      const pauseStatus = getDeliveryPauseStatus(settings);
      if (pauseStatus.paused) {
        return c.json({
          error: pauseStatus.message || 'Neste horário não realizamos entrega. Escolha retirada ou volte mais tarde.',
          delivery_paused: true,
        }, 409);
      }
    }

    const maxQtyLimit = Number(settings?.catalog_max_qty_per_product ?? 10) || 10;
    const reserve = Math.max(0, Number(settings?.catalog_stock_reserve ?? 0) || 0);
    const reservationMap = await buildReservationMap();
    const allowZeroStock = await getAllowZeroStock();

    const ids = items.map((i) => i.product_id).filter(Boolean);
    const { data: products } = await admin.from('product').select('*').in('id', ids);
    const prodById = Object.fromEntries((products || []).map((p) => [p.id, p]));

    let subtotal = 0;
    const saleItems = [];
    for (const it of items) {
      const p = prodById[it.product_id];
      if (!p) return c.json({ error: 'Produto não encontrado' }, 400);
      if (p.show_in_catalog !== true) return c.json({ error: 'Produto não disponível no catálogo' }, 400);
      const qty = Number(it.qty) || 0;
      if (qty <= 0) return c.json({ error: 'Quantidade inválida' }, 400);
      if (qty > maxQtyLimit) {
        return c.json({ error: `Quantidade máxima permitida por cliente para "${p.name}" foi atingida (${maxQtyLimit} un.).` }, 400);
      }
      const reserved = reservationMap[p.id] || 0;
      const catalogStock = computeCatalogAvailable(p.stock, reserve, reserved);
      if (qty > catalogStock && !allowZeroStock) {
        return c.json({ error: `Estoque insuficiente para ${p.name}` }, 409);
      }
      const total = Math.round((p.sale_price || 0) * qty * 100) / 100;
      subtotal = Math.round((subtotal + total) * 100) / 100;
      saleItems.push({ product_id: p.id, name: p.name, qty, unit_price: p.sale_price || 0, total });
    }

    let deliveryFee = 0;
    let neighborhoodName = '';
    if (deliveryType === 'entrega') {
      const { data: fees } = await admin
        .from('delivery_fee').select('*').eq('neighborhood', body.neighborhood).eq('active', true).limit(1);
      const fee = fees?.[0];
      if (!fee) return c.json({ error: 'Bairro sem taxa de entrega cadastrada' }, 400);
      deliveryFee = Number(fee.fee) || 0;
      neighborhoodName = fee.neighborhood;
    }

    const baseTotal = Math.round((subtotal + deliveryFee) * 100) / 100;
    const paymentMethod = ['pix', 'cartao_debito', 'cartao_credito', 'dinheiro'].includes(body.payment_method)
      ? body.payment_method
      : 'pix';

    let installments = 1;
    let cardRatePercent = 0;
    let feeAmount = 0;
    let total = baseTotal;
    if (paymentMethod === 'cartao_credito') {
      installments = Math.max(1, Math.min(12, Number(body.installments) || 1));
      const rates = settings?.card_installment_rates || [];
      const rateEntry = rates.find((r) => r.installments === installments);
      cardRatePercent = rateEntry ? Number(rateEntry.rate) || 0 : 0;
      feeAmount = Math.round(((baseTotal * cardRatePercent) / 100) * 100) / 100;
      total = Math.round((baseTotal + feeAmount) * 100) / 100;
    }

    let cashChangeFor = 0;
    if (paymentMethod === 'dinheiro' && body.needs_change) {
      cashChangeFor = Number(body.change_for) || 0;
      if (cashChangeFor > 0 && cashChangeFor < total) {
        return c.json({ error: 'Valor para troco deve ser maior ou igual ao total do pedido' }, 400);
      }
    }

    // Debitar estoque
    for (const it of saleItems) {
      const product = prodById[it.product_id];
      if (!product) continue;
      const newStock = Math.max(0, (Number(product.stock) || 0) - it.qty);
      await admin.from('product').update({ stock: newStock }).eq('id', it.product_id);
    }

    let pickupDeadline;
    if (deliveryType === 'retirada') {
      const days = Number(settings?.pickup_reservation_days) || 0;
      if (days > 0) {
        pickupDeadline = new Date(Date.now() + days * 86400000).toISOString();
      } else {
        const endOfDay = new Date();
        endOfDay.setHours(23, 59, 59, 999);
        pickupDeadline = endOfDay.toISOString();
      }
    }

    // Upsert cliente por telefone (evita cadastro duplicado)
    // Normaliza: só dígitos. Aceita com ou sem DDI 55.
    const rawPhone = String(customer.phone || '').replace(/\D/g, '');
    let phoneDigits = rawPhone;
    if (phoneDigits.startsWith('55') && phoneDigits.length >= 12) {
      phoneDigits = phoneDigits.slice(2); // remove DDI Brasil
    }
    // Remove zero à esquerda residual
    if (phoneDigits.startsWith('0') && phoneDigits.length > 10) {
      phoneDigits = phoneDigits.replace(/^0+/, '');
    }

    let customerId = null;
    if (customer.name && phoneDigits && phoneDigits.length >= 8) {
      try {
        // Busca candidatos pelo telefone (exato e variações comuns)
        const variants = [
          phoneDigits,
          '55' + phoneDigits,
          phoneDigits.length === 11 ? phoneDigits.slice(2) : null, // sem DDD
        ].filter(Boolean);

        let custQuery = admin
          .from('customer')
          .select('*')
          .or(variants.map((v) => `phone.eq.${v}`).join(','))
          .limit(20);
        if (storeOwnerId) custQuery = custQuery.eq('created_by', storeOwnerId);
        const { data: candidates } = await custQuery;

        // Confirma match comparando só dígitos (mais seguro)
        const match = (candidates || []).find((cu) => {
          let p = String(cu.phone || '').replace(/\D/g, '');
          if (p.startsWith('55') && p.length >= 12) p = p.slice(2);
          return p === phoneDigits || p.endsWith(phoneDigits) || phoneDigits.endsWith(p);
        });

        if (match) {
          // Cliente já existe nesta loja → atualiza dados faltantes (não duplica)
          const updates = {};
          if (customer.name && (!match.name || match.name.length < 3)) {
            updates.name = customer.name;
          }
          if (!match.whatsapp) updates.whatsapp = phoneDigits;
          if (String(match.phone || '').replace(/\D/g, '') !== phoneDigits) {
            updates.phone = phoneDigits;
          }
          if (deliveryType === 'entrega') {
            if (body.street && !match.street) updates.street = body.street;
            if (body.number && !match.number) updates.number = body.number;
            if (body.complement && !match.complement) updates.complement = body.complement;
            if (body.neighborhood && !match.neighborhood) updates.neighborhood = body.neighborhood;
            if (body.city && !match.city) updates.city = body.city;
            if (body.state && !match.state) updates.state = body.state;
            if (body.cep && !match.cep) updates.cep = String(body.cep || '').replace(/\D/g, '');
          }
          if (Object.keys(updates).length) {
            await admin.from('customer').update(updates).eq('id', match.id);
          }
          customerId = match.id;
        } else {
          // Cliente novo desta loja → cadastra uma vez
          const row = {
            person_type: 'fisica',
            name: customer.name.trim(),
            phone: phoneDigits,
            whatsapp: phoneDigits,
            active: true,
            created_by: storeOwnerId || null,
          };
          if (deliveryType === 'entrega') {
            Object.assign(row, {
              street: body.street || '',
              number: body.number || '',
              complement: body.complement || '',
              neighborhood: body.neighborhood || '',
              city: body.city || '',
              state: body.state || '',
              cep: String(body.cep || '').replace(/\D/g, ''),
            });
          }
          const { data: created, error: custErr } = await admin
            .from('customer')
            .insert(row)
            .select()
            .single();
          if (custErr) {
            console.error('customer insert error', custErr.message);
          } else {
            customerId = created?.id || null;
          }
        }

      } catch (e) {
        console.error('customer auto-upsert error', e);
      }
    }


    // Vincula ao caixa aberto (mesmo fluxo da loja — um único caixa)
    const openSession = openSessions[0];

    const saleOwnerId = storeOwnerId || openSession?.created_by || null;

    const salePayload = {
      customer_name: customer.name,
      customer_phone: customer.phone,
      customer_id: customerId || null,
      seller_id: seller.id,
      seller_name: seller.name,
      delivery_type: deliveryType,
      items: saleItems,
      subtotal,
      discount: 0,
      total,
      // Retirada no balcão pode ser tratada como pedido em aberto até retirada;
      // entrega começa em orçamento/aguardando e só conclui na entrega + prestação.
      status: deliveryType === 'retirada' ? 'orcamento' : 'orcamento',
      source: 'catalog',
      cash_session_id: openSession?.id || null,
      created_by: saleOwnerId,
      notes: customer.notes || '',

      delivery_address: deliveryType === 'entrega' ? (body.street || '') : '',
      delivery_number: deliveryType === 'entrega' ? (body.number || '') : '',
      delivery_complement: deliveryType === 'entrega' ? (body.complement || '') : '',
      delivery_reference: deliveryType === 'entrega' ? (body.reference || '') : '',
      delivery_neighborhood: neighborhoodName,
      delivery_city: deliveryType === 'entrega' ? (body.city || '') : '',
      delivery_state: deliveryType === 'entrega' ? (body.state || '') : '',
      delivery_cep: deliveryType === 'entrega' ? String(body.cep || '').replace(/\D/g, '') : '',
      delivery_fee: deliveryFee,
      delivery_status: deliveryType === 'entrega' ? 'aguardando' : null,
      pickup_status: deliveryType === 'retirada' ? 'aguardando' : null,
      payment_method: paymentMethod,
      installments,
      card_rate_percent: cardRatePercent,
      fee_amount: feeAmount,
      net_amount: baseTotal,
      cash_change_for: cashChangeFor,
      ...(pickupDeadline ? { pickup_deadline: pickupDeadline } : {}),
      ...(deliveryType === 'entrega' && paymentMethod === 'dinheiro' ? { cash_confirmed: false } : {}),
    };

    const { data: sale, error: saleErr } = await admin.from('sale').insert(salePayload).select().single();
    if (saleErr) {
      // rollback stock best-effort
      for (const it of saleItems) {
        const p = prodById[it.product_id];
        if (p) await admin.from('product').update({ stock: p.stock }).eq('id', it.product_id);
      }
      return c.json({ error: saleErr.message }, 500);
    }

    // Notificação in-app
    try {
      const orderNum = String(sale.id).slice(-6).toUpperCase();
      const modality = sale.delivery_type === 'entrega' ? 'Entrega' : 'Retirada';
      await admin.from('notification').insert({
        title: `Novo pedido #${orderNum}`,
        message: `${modality} · ${sale.customer_name || 'Cliente'} · R$ ${Number(sale.total || 0).toFixed(2)}`,
        sale_id: sale.id,
        type: 'novo_pedido',
        delivery_type: sale.delivery_type || 'retirada',
        read: false,
        created_by: saleOwnerId,
      });

    } catch (e) {
      console.error('notification create error', e);
    }

    return c.json({ success: true, sale_id: sale.id });
  } catch (error) {
    console.error('catalog-checkout error', error);
    return c.json({ error: error.message }, 500);
  }
});

export default catalog;
