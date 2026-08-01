import { Hono } from 'hono';
import { admin } from './db.js';
import { requireUser } from './helpers.js';

const catalogExtra = new Hono();

catalogExtra.post('/catalog-receipt', async (c) => {
  try {
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);
    const body = await c.req.json().catch(() => ({}));
    const saleId = body.sale_id || body.id;
    if (!saleId) return c.json({ error: 'sale_id obrigatório' }, 400);

    const { data: sale } = await admin.from('sale').select('*').eq('id', saleId).maybeSingle();
    if (!sale) return c.json({ error: 'Pedido não encontrado' }, 404);
    if (sale.source !== 'catalog') {
      return c.json({ error: 'Recibo disponível apenas para pedidos do catálogo' }, 400);
    }

    const { data: settingsList } = await admin
      .from('app_settings').select('*').order('created_at', { ascending: false }).limit(1);
    const cfg = settingsList?.[0] || {};

    return c.json({
      sale,
      company: {
        name: cfg.company_name || '',
        logo: cfg.company_logo_url || '',
        whatsapp: cfg.catalog_whatsapp || '',
      },
    });
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

catalogExtra.post('/catalog-expire-pickups', async (c) => {
  try {
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);
    const now = new Date().toISOString();
    const { data: expired } = await admin
      .from('sale')
      .select('id,items,status,pickup_status,pickup_deadline')
      .eq('delivery_type', 'retirada')
      .eq('pickup_status', 'aguardando')
      .eq('status', 'orcamento')
      .limit(200);

    let count = 0;
    for (const s of expired || []) {
      if (!s.pickup_deadline || s.pickup_deadline > now) continue;
      // restore stock
      for (const it of s.items || []) {
        if (!it.product_id || !it.qty) continue;
        const { data: p } = await admin.from('product').select('stock').eq('id', it.product_id).maybeSingle();
        if (p) {
          await admin.from('product').update({ stock: (Number(p.stock) || 0) + Number(it.qty) }).eq('id', it.product_id);
        }
      }
      await admin.from('sale').update({
        pickup_status: 'expirado',
        status: 'cancelado',
      }).eq('id', s.id);
      count++;
    }
    return c.json({ ok: true, expired: count });
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

catalogExtra.post('/address-search', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const query = String(body.query || '').trim();
    if (query.length < 3) {
      return c.json({ error: 'Informe ao menos 3 caracteres para a busca.' }, 400);
    }

    // ViaCEP se for CEP puro
    const digits = query.replace(/\D/g, '');
    if (digits.length === 8) {
      try {
        const r = await fetch(`https://viacep.com.br/ws/${digits}/json/`, { signal: AbortSignal.timeout(8000) });
        const j = await r.json();
        if (!j.erro) {
          return c.json({
            candidates: [{
              cep: digits,
              street: j.logradouro || '',
              neighborhood: j.bairro || '',
              city: j.localidade || '',
              state: j.uf || '',
            }],
          });
        }
      } catch { /* fallthrough */ }
    }

    // BrasilAPI / OpenStreetMap Nominatim fallback
    try {
      const r = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&countrycodes=br&limit=5&q=${encodeURIComponent(query)}`,
        {
          headers: { 'User-Agent': 'DarochaPDV/1.0' },
          signal: AbortSignal.timeout(10000),
        }
      );
      const arr = await r.json();
      const candidates = (arr || []).map((a) => {
        const parts = (a.display_name || '').split(',').map((s) => s.trim());
        return {
          cep: '',
          street: parts[0] || '',
          neighborhood: parts[1] || '',
          city: parts[parts.length - 3] || parts[2] || '',
          state: (parts[parts.length - 2] || '').slice(0, 2).toUpperCase(),
        };
      });
      return c.json({ candidates });
    } catch (e) {
      return c.json({ candidates: [], error: e.message });
    }
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

export default catalogExtra;
