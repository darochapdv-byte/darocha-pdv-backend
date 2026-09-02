import { Hono } from 'hono';
import { admin } from './db.js';
import {
  buildReservationMap,
  computeCatalogAvailable,
  getDeliveryPauseStatus,
  resolveStoreBySlug,
  ensureCatalogSlug,
  generateUniqueCatalogSlug,
  setCatalogSlug,
  requireUser,
  getAllowZeroStock,
  buildStorePublicUrl,
  normalizeSlug,
} from './helpers.js';

const catalog = new Hono();

/** Extrai slug: body, query, Referer ou subdomínio do Host (ex: eldorado.darochapdv.com). */
function extractSlugFromRequest(c, body = {}) {
  let slug = String(body?.slug || body?.loja || body?.store || '').trim();
  if (!slug) {
    try {
      const url = new URL(c.req.url);
      slug = url.searchParams.get('loja') || url.searchParams.get('slug') || '';
    } catch { /* ignore */ }
  }
  if (!slug) {
    const ref = c.req.header('Referer') || c.req.header('Referrer') || '';
    const m =
      ref.match(/[?&]loja=([a-zA-Z0-9-]+)/) ||
      ref.match(/[?&]slug=([a-zA-Z0-9-]+)/) ||
      ref.match(/\/catalogo\/([a-zA-Z0-9-]+)/) ||
      ref.match(/https?:\/\/([a-z0-9-]+)\.darochapdv\.com/i);
    if (m) slug = m[1];
  }
  if (!slug) {
    const host = (c.req.header('X-Forwarded-Host') || c.req.header('Host') || '').split(',')[0].trim().toLowerCase();
    // eldorado.darochapdv.com ou eldorado.dist-ten-mu-12.vercel.app
    const hm = host.match(/^([a-z0-9-]+)\.(?:darochapdv\.com|[^.]+\.vercel\.app)$/i);
    if (hm) {
      const sub = hm[1];
      const reservedHost = new Set(['www','api','app','admin','mail','ftp','cdn','static','assets','dashboard','painel','suporte','support']);
      if (sub && !reservedHost.has(sub)) slug = sub;
    }
  }
  return normalizeSlug(slug);
}


/** Carrega app_settings + profile de um dono de loja específico. */
async function loadStoreConfig(storeOwnerId) {
  let cfg = null;
  if (storeOwnerId) {
    const { data: settingsList } = await admin
      .from('app_settings')
      .select('*')
      .eq('created_by', storeOwnerId)
      .order('created_at', { ascending: false })
      .limit(20);
    cfg = settingsList?.[0] || null;
    // card_installment_rates pode estar em outra linha de settings da mesma loja
    if (cfg && (!cfg.card_installment_rates || !cfg.card_installment_rates.length)) {
      const withRates = (settingsList || []).find(
        (s) => Array.isArray(s.card_installment_rates) && s.card_installment_rates.length
      );
      if (withRates) {
        cfg = { ...cfg, card_installment_rates: withRates.card_installment_rates };
      }
    }
  }
  const { data: profile } = storeOwnerId
    ? await admin.from('profiles').select('*').eq('id', storeOwnerId).maybeSingle()
    : { data: null };
  return { cfg, profile };
}

catalog.post('/catalog-data', async (c) => {
  try {
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);

    const body = await c.req.json().catch(() => ({}));
    const slugParam = extractSlugFromRequest(c, body);

    let storeOwnerId = null;
    let catalogSlug = null;

    if (slugParam) {
      const resolved = await resolveStoreBySlug(slugParam);
      if (!resolved) {
        return c.json({
          enabled: false,
          products: [],
          fees: [],
          categories: [],
          brands: [],
          sellers: [],
          error: 'Loja não encontrada. Verifique o link do catálogo.',
          slug: slugParam,
        }, 200);
      }
      storeOwnerId = resolved.userId;
      catalogSlug = resolved.slug;
    } else {
      // Sem slug: se logado, usa a loja do usuário (prévia dentro do PDV)
      const user = await requireUser(c);
      if (user?.id) {
        storeOwnerId = user.id;
        try {
          const { data: profile } = await admin.from('profiles').select('company_name').eq('id', user.id).maybeSingle();
          catalogSlug = await ensureCatalogSlug(user.id, profile?.company_name || null);
        } catch {
          catalogSlug = null;
        }
      } else {
        // HTTP 200 para o frontend antigo não quebrar (ele trata enabled:false)
        return c.json({
          enabled: false,
          products: [],
          fees: [],
          categories: [],
          brands: [],
          sellers: [],
          error: 'Informe o link da loja (ex: /catalogo?loja=nomedaloja). Cada loja tem um catálogo exclusivo.',
        });
      }
    }

    const { cfg, profile } = await loadStoreConfig(storeOwnerId);
    const maxQtyLimit = Number(cfg?.catalog_max_qty_per_product ?? 10) || 10;

    if (cfg && cfg.catalog_enabled === false) {
      return c.json({
        enabled: false, products: [], fees: [], categories: [], brands: [], sellers: [],
        whatsapp: cfg?.catalog_whatsapp || '',
        slug: catalogSlug,
      });
    }

    const reserve = Math.max(0, Number(cfg?.catalog_stock_reserve ?? 0) || 0);
    const reservationMap = await buildReservationMap();
    // allow_zero_stock: usa o valor da loja; se vier null/undefined (coluna antiga),
    // consulta a política salva (getAllowZeroStock). Assim o catálogo respeita
    // "Autorizar venda sem estoque" das Configurações.
    let allowZeroStock = false;
    try {
      allowZeroStock = await getAllowZeroStock(storeOwnerId);
    } catch {
      allowZeroStock =
        cfg?.allow_zero_stock === true ||
        cfg?.allow_zero_stock === 'true' ||
        cfg?.allow_zero_stock === 1;
    }

    const { data: products } = await admin
      .from('product')
      .select('*')
      .eq('created_by', storeOwnerId)
      .order('updated_at', { ascending: false })
      .limit(500);

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

    const { data: fees } = await admin.from('delivery_fee').select('*').eq('active', true).eq('created_by', storeOwnerId);

    const { data: sellers } = await admin
      .from('seller').select('id,name').eq('status', 'ativo').eq('created_by', storeOwnerId)
      .order('created_at', { ascending: false }).limit(200);

    const { data: openSessions } = await admin.from('cash_session').select('id,created_by').eq('status', 'aberto')
      .eq('created_by', storeOwnerId).limit(5);

    const pauseStatus = getDeliveryPauseStatus(cfg);
    let mpConnected = false;
    try {
      const { loadMpAccount } = await import('./payments_mp.js');
      const mpAcc = await loadMpAccount(storeOwnerId);
      mpConnected = !!(mpAcc && mpAcc.status === 'connected' && mpAcc.access_token_encrypted);
    } catch {}

    return c.json({
      enabled: true,
      products: available,
      categories,
      brands,
      fees: (fees || []).map((f) => ({
        id: f.id, neighborhood: f.neighborhood, fee: f.fee, delivery_time: f.delivery_time || '',
      })),
      sellers: (sellers || []).map((s) => ({ id: s.id, name: s.name })),
      whatsapp: cfg?.catalog_whatsapp || profile?.phone || '',
      company_name: cfg?.company_name || profile?.company_name || '',
      card_rates: cfg?.card_installment_rates || [],
      max_qty_per_product: maxQtyLimit,
      store_open: (openSessions || []).length > 0,
      sell_when_closed: !!(cfg?.catalog_sell_when_closed === true || cfg?.catalog_sell_when_closed === 'true' || cfg?.role_payment_methods?.__catalog_sell_when_closed),
      mp_connected: mpConnected,
      delivery_paused: pauseStatus.paused,
      delivery_pause_message: pauseStatus.message,
      slug: catalogSlug,
      company: {
        company_name: cfg?.company_name || profile?.company_name || '',
        company_logo_url: cfg?.company_logo_url || '',
        brand_color: cfg?.brand_color || '#4f46e5',
        catalog_slogan: cfg?.catalog_slogan || 'Compre online com praticidade e segurança',
        company_cnpj: profile?.company_cnpj || '',
        company_phone: profile?.company_phone || '',
        referral_code: profile?.referral_code || '',
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

/** Retorna o link único do catálogo da loja logada (cria slug se ainda não existir). */
catalog.post('/my-catalog-link', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);

    const { data: profile } = await admin.from('profiles').select('company_name,referral_code').eq('id', user.id).maybeSingle();
    const slug = await ensureCatalogSlug(user.id, profile?.company_name || null);

    const catalogUrl = buildStorePublicUrl(slug);

    return c.json({
      slug,
      catalog_url: catalogUrl,
      company_name: profile?.company_name || null,
    });
  } catch (error) {
    console.error('my-catalog-link', error);
    return c.json({ error: error.message || 'error' }, 500);
  }
});

/** Redefine o slug da loja (deve ser único entre todas as contas). */
catalog.post('/set-catalog-slug', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const body = await c.req.json().catch(() => ({}));
    let desired = String(body.slug || body.loja || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 48);

    if (!desired) {
      const { data: profile } = await admin.from('profiles').select('company_name').eq('id', user.id).maybeSingle();
      desired = await generateUniqueCatalogSlug(profile?.company_name, user.id);
    }

    await setCatalogSlug(user.id, desired);
    const catalogUrl = buildStorePublicUrl(desired);

    return c.json({ slug: desired, catalog_url: catalogUrl });
  } catch (error) {
    const msg = error.message || 'error';
    const status = msg.includes('já está em uso') ? 409 : 500;
    return c.json({ error: msg }, status);
  }
});

catalog.post('/catalog-store-status', async (c) => {
  try {
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);
    const body = await c.req.json().catch(() => ({}));
    const slugParam = extractSlugFromRequest(c, body);
    let storeOwnerId = null;
    if (slugParam) {
      const resolved = await resolveStoreBySlug(slugParam);
      if (!resolved) return c.json({ error: 'Loja não encontrada', open: false }, 404);
      storeOwnerId = resolved.userId;
    } else {
      const user = await requireUser(c);
      if (user?.id) storeOwnerId = user.id;
    }
    let sessionsQuery = admin.from('cash_session').select('id').eq('status', 'aberto').limit(1);
    if (storeOwnerId) sessionsQuery = sessionsQuery.eq('created_by', storeOwnerId);
    const { data: openSessions } = await sessionsQuery;
    let cfg = null;
    if (storeOwnerId) {
      const { data: settingsList } = await admin
        .from('app_settings').select('*').eq('created_by', storeOwnerId)
        .order('created_at', { ascending: false }).limit(1);
      cfg = settingsList?.[0];
    }
    const pauseStatus = getDeliveryPauseStatus(cfg);
    return c.json({
      store_open: (openSessions || []).length > 0,
      open: (openSessions || []).length > 0,
      sell_when_closed: !!(cfg?.catalog_sell_when_closed === true || cfg?.catalog_sell_when_closed === 'true' || cfg?.role_payment_methods?.__catalog_sell_when_closed),
      catalog_enabled: cfg?.catalog_enabled !== false,
      whatsapp: cfg?.catalog_whatsapp || '',
      delivery_paused: pauseStatus.paused,
      delivery_pause_message: pauseStatus.message,
      slug: slugParam || null,
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

    const slugParam = extractSlugFromRequest(c, body);
    let storeOwnerId = null;
    let settings = null;
    if (slugParam) {
      const resolved = await resolveStoreBySlug(slugParam);
      if (!resolved) return c.json({ error: 'Loja não encontrada. Verifique o link do catálogo.' }, 404);
      storeOwnerId = resolved.userId;
      const loaded = await loadStoreConfig(storeOwnerId);
      settings = loaded.cfg;
    } else {
      return c.json({ error: 'Informe o link da loja (slug) para finalizar a compra.' }, 400);
    }

    const { data: seller } = await admin.from('seller').select('*').eq('id', body.seller_id).maybeSingle();
    if (!seller || seller.status !== 'ativo') {
      return c.json({ error: 'Vendedor inválido ou inativo' }, 400);
    }
    // Vendedor deve pertencer à mesma loja
    if (storeOwnerId && seller.created_by && seller.created_by !== storeOwnerId) {
      return c.json({ error: 'Vendedor inválido ou inativo' }, 400);
    }

    const wantsCardPix = ['pix','cartao_credito','cartao_debito'].includes(String(body.payment_method||''));
    let payOnline = body.pay_online === true || body.online_payment === true
      || body.payment_flow === 'online'
      || wantsCardPix;
    let sessionsQuery = admin.from('cash_session').select('id,created_by').eq('status', 'aberto').limit(5);
    if (storeOwnerId) sessionsQuery = sessionsQuery.eq('created_by', storeOwnerId);
    const { data: openSessions } = await sessionsQuery;
    const sellWhenClosed = !!(settings?.catalog_sell_when_closed === true || settings?.catalog_sell_when_closed === 'true' || settings?.role_payment_methods?.__catalog_sell_when_closed);
    if (!openSessions?.length && !payOnline && !sellWhenClosed) {
      return c.json({
        error: 'Nossa loja está fechada no momento. Você pode montar seu carrinho normalmente e finalizar seu pedido assim que houver um caixa aberto. Agradecemos sua compreensão!',
        store_closed: true,
      }, 409);
    }
    if (payOnline && storeOwnerId) {
      try {
        const { loadMpAccount } = await import('./payments_mp.js');
        const mpAcc = await loadMpAccount(storeOwnerId);
        if (!(mpAcc && mpAcc.status === 'connected' && mpAcc.access_token_encrypted)) {
          payOnline = false;
        }
      } catch (e) {
        console.warn('mp check', e.message);
        payOnline = false;
      }
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
    let allowZeroStock = false;
    try {
      allowZeroStock = await getAllowZeroStock(storeOwnerId);
    } catch {
      allowZeroStock =
        settings?.allow_zero_stock === true ||
        settings?.allow_zero_stock === 'true' ||
        settings?.allow_zero_stock === 1;
    }

    const ids = items.map((i) => i.product_id).filter(Boolean);
    let prodQuery = admin.from('product').select('*').in('id', ids);
    if (storeOwnerId) prodQuery = prodQuery.eq('created_by', storeOwnerId);
    const { data: products } = await prodQuery;
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
      const rateEntry = Array.isArray(rates) ? rates.find((r) => Number(r.installments) === installments) : null;
      cardRatePercent = rateEntry ? Number(rateEntry.rate) || 0 : (Number(body.card_rate_percent) || 0);
      // se frontend mandou fee já calculado, respeita (com teto de sanidade)
      const bodyFee = Number(body.fee_amount);
      if (Number.isFinite(bodyFee) && bodyFee >= 0 && bodyFee <= baseTotal) {
        feeAmount = Math.round(bodyFee * 100) / 100;
        cardRatePercent = baseTotal > 0 ? Math.round((feeAmount / baseTotal) * 10000) / 100 : cardRatePercent;
      } else {
        feeAmount = Math.round(((baseTotal * cardRatePercent) / 100) * 100) / 100;
      }
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
      // Pagamento online: estoque só baixa após confirmação do Mercado Pago
      if (!payOnline) {
        const newStock = Math.max(0, (Number(product.stock) || 0) - it.qty);
        await admin.from('product').update({ stock: newStock }).eq('id', it.product_id);
      }
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
        // Match estrito após normalizar (não endsWith — evita misturar clientes diferentes)
        const match = (candidates || []).find((cu) => {
          let p = String(cu.phone || '').replace(/\D/g, '');
          if (p.startsWith('55') && p.length >= 12) p = p.slice(2);
          if (p.startsWith('0') && p.length > 10) p = p.replace(/^0+/, '');
          return p === phoneDigits;
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
            if (body.street) updates.street = body.street;
            if (body.number) updates.number = body.number;
            if (body.complement) updates.complement = body.complement;
            if (body.neighborhood) updates.neighborhood = body.neighborhood;
            if (body.city) updates.city = body.city;
            if (body.state) updates.state = body.state;
            if (body.cep) updates.cep = String(body.cep || '').replace(/\D/g, '');
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
    const openSession = (openSessions && openSessions[0]) || null;

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
      status: payOnline ? 'pending_payment' : 'orcamento',
      source: 'catalog',
      cash_session_id: openSession?.id || null,
      created_by: saleOwnerId,
      notes: [!openSession ? '[PEDIDO FORA DO HORÁRIO — separar quando o caixa abrir]' : '', customer.notes || ''].filter(Boolean).join(' '),

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

    try {
      const since = new Date(Date.now() - 12 * 60 * 1000).toISOString();
      let dq = admin.from('sale').select('*').eq('source', 'catalog').eq('total', total).gte('created_at', since).order('created_at', { ascending: false }).limit(15);
      if (saleOwnerId) dq = dq.eq('created_by', saleOwnerId);
      const { data: recent } = await dq;
      const phoneKey = String(customer.phone || phoneDigits || '').replace(/\D/g, '').slice(-11);
      const dup = (recent || []).find((row) => {
        const p = String(row.customer_phone || '').replace(/\D/g, '').slice(-11);
        return p && phoneKey && p === phoneKey && String(row.status || '') !== 'cancelada';
      });
      if (dup) {
        if (payOnline && (dup.status === 'orcamento' || dup.status === 'orçamento')) {
          await admin.from('sale').update({ status: 'pending_payment', payment_method: paymentMethod }).eq('id', dup.id);
          dup.status = 'pending_payment';
        }
        return c.json({
          success: true,
          sale_id: dup.id,
          total: dup.total,
          need_payment: payOnline,
          pay_online: payOnline,
          reused: true,
          mp_public_key: null,
        });
      }
    } catch (e) {
      console.warn('catalog checkout dedupe', e.message);
    }

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
      if (!payOnline) {
        await admin.from('notification').insert({
          title: `Novo pedido #${orderNum}`,
          message: `${modality} · ${sale.customer_name || 'Cliente'} · R$ ${Number(sale.total || 0).toFixed(2)}`,
          sale_id: sale.id,
          type: 'novo_pedido',
          delivery_type: sale.delivery_type || 'retirada',
          read: false,
          created_by: saleOwnerId,
        });
      }

    } catch (e) {
      console.error('notification create error', e);
    }

    let mp_public_key = null;
    if (payOnline) {
      try {
        const { loadMpAccount } = await import('./payments_mp.js');
        const acc = await loadMpAccount(saleOwnerId);
        mp_public_key = process.env.MP_PUBLIC_KEY || acc?.public_key || null;
      } catch (_) {}
    }
    return c.json({
      success: true,
      sale_id: sale.id,
      need_payment: !!payOnline,
      payment_method: paymentMethod,
      total: sale.total,
      pay_online: !!payOnline,
      mp_public_key,
    });
  } catch (error) {
    console.error('catalog-checkout error', error);
    return c.json({ error: error.message }, 500);
  }
});

export default catalog;
