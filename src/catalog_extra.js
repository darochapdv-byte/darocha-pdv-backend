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

    const digits = query.replace(/\D/g, '');

    // 1) CEP puro (8 dígitos)
    if (digits.length === 8) {
      try {
        const r = await fetch(`https://viacep.com.br/ws/${digits}/json/`, { signal: AbortSignal.timeout(8000) });
        const j = await r.json();
        if (!j.erro) {
          return c.json({
            candidates: [{
              cep: String(j.cep || digits).replace(/\D/g, ''),
              street: j.logradouro || '',
              neighborhood: j.bairro || '',
              city: j.localidade || '',
              state: j.uf || '',
            }],
          });
        }
      } catch { /* fallthrough */ }
    }

    // 2) ViaCEP por UF/cidade/logradouro — formato: "Rua X, Cidade - UF" ou "Rua X Cidade UF"
    async function viaCepStreet(uf, city, street) {
      if (!uf || !city || !street || street.length < 3) return [];
      const url = `https://viacep.com.br/ws/${encodeURIComponent(uf)}/${encodeURIComponent(city)}/${encodeURIComponent(street)}/json/`;
      const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const j = await r.json();
      const arr = Array.isArray(j) ? j : (j && !j.erro ? [j] : []);
      return arr.slice(0, 8).map((row) => ({
        cep: String(row.cep || '').replace(/\D/g, ''),
        street: row.logradouro || street,
        neighborhood: row.bairro || '',
        city: row.localidade || city,
        state: row.uf || uf,
      })).filter((x) => x.cep);
    }

    // Tenta extrair UF (2 letras no final) e cidade
    let ufGuess = '';
    let cityGuess = '';
    let streetGuess = query;
    const ufMatch = query.match(/\b([A-Za-z]{2})\s*$/);
    if (ufMatch) {
      ufGuess = ufMatch[1].toUpperCase();
      streetGuess = query.slice(0, ufMatch.index).trim().replace(/[,-]\s*$/, '');
    }
    // "rua, cidade" ou "rua - cidade"
    const parts = streetGuess.split(/,|\s+-\s+/).map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      streetGuess = parts[0];
      cityGuess = parts[parts.length - 1];
    }

    // UFs comuns se não informada — tenta com cidades do body
    const bodyCity = String(body.city || body.cidade || '').trim();
    const bodyUf = String(body.state || body.uf || ufGuess || '').trim().toUpperCase();
    if (bodyCity) cityGuess = bodyCity;
    if (bodyUf) ufGuess = bodyUf;

    if (ufGuess && cityGuess && streetGuess) {
      try {
        const found = await viaCepStreet(ufGuess, cityGuess, streetGuess);
        if (found.length) return c.json({ candidates: found });
      } catch { /* fallthrough */ }
    }

    // 3) Nominatim + enriquecer CEP via ViaCEP
    try {
      const r = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&countrycodes=br&limit=6&q=${encodeURIComponent(query + ' Brasil')}`,
        {
          headers: { 'User-Agent': 'DarochaPDV/1.0 (contato@darochapdv.com)' },
          signal: AbortSignal.timeout(10000),
        }
      );
      const arr = await r.json();
      const candidates = [];
      for (const a of arr || []) {
        const addr = a.address || {};
        const street = addr.road || addr.pedestrian || addr.street || (a.display_name || '').split(',')[0] || '';
        const neighborhood = addr.suburb || addr.neighbourhood || addr.quarter || addr.city_district || '';
        const city = addr.city || addr.town || addr.village || addr.municipality || '';
        const state = String(addr.state_code || addr.state || '').slice(0, 2).toUpperCase();
        let cep = String(addr.postcode || '').replace(/\D/g, '').slice(0, 8);

        // Se não veio CEP, tenta ViaCEP com rua+cidade+UF
        if (cep.length !== 8 && state && city && street) {
          try {
            const extra = await viaCepStreet(state, city, street.split(',')[0].trim());
            if (extra[0]?.cep) {
              cep = extra[0].cep;
              candidates.push({
                cep,
                street: extra[0].street || street,
                neighborhood: extra[0].neighborhood || neighborhood,
                city: extra[0].city || city,
                state: extra[0].state || state,
              });
              continue;
            }
          } catch { /* ignore */ }
        }

        candidates.push({
          cep: cep.length === 8 ? cep : '',
          street,
          neighborhood,
          city,
          state,
        });
      }
      // Preferir os que têm CEP
      candidates.sort((a, b) => (b.cep ? 1 : 0) - (a.cep ? 1 : 0));
      return c.json({ candidates });
    } catch (e) {
      return c.json({ candidates: [], error: e.message });
    }
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

export default catalogExtra;
