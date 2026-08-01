import { Hono } from 'hono';
import { admin } from './db.js';
import { requireUser } from './helpers.js';

const products = new Hono();

async function fetchOpenFoodFacts(code) {
  try {
    const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const p = j?.product;
    if (!p) return null;
    return {
      found: true,
      name: p.product_name || p.product_name_pt || p.generic_name || '',
      brand: (p.brands || '').split(',')[0]?.trim() || '',
      category: (p.categories_tags?.[0] || '').replace('en:', '') || '',
      image_url: p.image_front_url || p.image_url || '',
      barcode: code,
      source: 'openfoodfacts',
    };
  } catch {
    return null;
  }
}

async function fetchUpcItemDb(code) {
  try {
    const r = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(code)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const item = j?.items?.[0];
    if (!item) return null;
    return {
      found: true,
      name: item.title || '',
      brand: item.brand || '',
      category: item.category || '',
      image_url: item.images?.[0] || '',
      barcode: code,
      source: 'upcitemdb',
    };
  } catch {
    return null;
  }
}

async function lookupFromCache(code) {
  if (!admin) return null;
  const { data } = await admin.from('barcode_knowledge').select('*').eq('barcode', code).limit(1);
  const row = data?.[0];
  if (!row) return null;
  return {
    found: true,
    name: row.name || '',
    brand: row.brand || '',
    category: row.category || '',
    image_url: row.image_url || '',
    barcode: code,
    source: 'cache',
  };
}

async function persistKnowledge(code, info) {
  if (!admin || !info?.name) return;
  try {
    await admin.from('barcode_knowledge').upsert({
      barcode: code,
      name: info.name,
      brand: info.brand || '',
      category: info.category || '',
      image_url: info.image_url || '',
      source: info.source || 'lookup',
    });
  } catch (e) {
    console.error('persistKnowledge', e);
  }
}

async function invokeLlmLookup(code) {
  const key = process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY;
  if (!key) return null;
  // Placeholder structure — plug real provider
  try {
    if (process.env.OPENAI_API_KEY) {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: 'Retorne JSON {found,name,brand,category} para o produto do código de barras brasileiro/EAN.',
            },
            { role: 'user', content: `Código de barras: ${code}` },
          ],
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) return null;
      const j = await r.json();
      const text = j.choices?.[0]?.message?.content || '{}';
      const parsed = JSON.parse(text);
      if (parsed?.found && parsed?.name) {
        return { ...parsed, barcode: code, source: 'llm', image_url: '' };
      }
    }
  } catch (e) {
    console.error('llm lookup', e);
  }
  return null;
}

products.post('/barcode-lookup', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const code = String(body.code || body.barcode || '').replace(/\D/g, '');
    if (!code || code.length < 8) {
      return c.json({ found: false, message: 'Código inválido' }, 400);
    }

    const cached = await lookupFromCache(code);
    if (cached?.found) return c.json(cached);

    const [off, upc] = await Promise.all([fetchOpenFoodFacts(code), fetchUpcItemDb(code)]);
    let best = off?.found ? off : upc?.found ? upc : null;
    if (!best) best = await invokeLlmLookup(code);

    if (best?.found) {
      await persistKnowledge(code, best);
      return c.json(best);
    }
    return c.json({ found: false, barcode: code, message: 'Produto não encontrado' });
  } catch (error) {
    return c.json({ found: false, error: error.message }, 500);
  }
});

products.post('/product-name-lookup', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const name = String(body.name || body.query || '').trim();
    if (name.length < 2) return c.json({ found: false, results: [] }, 400);

    if (!admin) return c.json({ found: false, results: [] });

    const { data: local } = await admin
      .from('product')
      .select('id,name,brand,category,sale_price,barcode,image_url,stock')
      .or(`name.ilike.%${name}%,barcode.ilike.%${name}%,brand.ilike.%${name}%`)
      .limit(20);

    let external = null;
    const key = process.env.OPENAI_API_KEY;
    if (key && (!local || local.length < 3)) {
      try {
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: 'Retorne JSON {results:[{name,brand,category}]} até 5 produtos de mercado BR.' },
              { role: 'user', content: name },
            ],
          }),
          signal: AbortSignal.timeout(12000),
        });
        if (r.ok) {
          const j = await r.json();
          external = JSON.parse(j.choices?.[0]?.message?.content || '{}').results || [];
        }
      } catch { /* ignore */ }
    }

    return c.json({
      found: (local && local.length > 0) || (external && external.length > 0),
      products: local || [],
      suggestions: external || [],
    });
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

products.post('/enrich-product', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const body = await c.req.json().catch(() => ({}));
    const code = String(body.barcode || body.code || '').replace(/\D/g, '');
    const productId = body.product_id;

    let info = null;
    if (code) {
      info = await lookupFromCache(code);
      if (!info?.found) {
        const [off, upc] = await Promise.all([fetchOpenFoodFacts(code), fetchUpcItemDb(code)]);
        info = off?.found ? off : upc;
        if (!info) info = await invokeLlmLookup(code);
        if (info?.found) await persistKnowledge(code, info);
      }
    }

    if (!info?.found) return c.json({ found: false, message: 'Não foi possível enriquecer' });

    if (productId && admin) {
      const patch = {};
      if (info.name) patch.name = info.name;
      if (info.brand) patch.brand = info.brand;
      if (info.category) patch.category = info.category;
      if (info.image_url) patch.image_url = info.image_url;
      if (code) patch.barcode = code;
      await admin.from('product').update(patch).eq('id', productId);
    }

    return c.json({ found: true, ...info, product_id: productId || null });
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

products.post('/save-product', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);
    const body = await c.req.json().catch(() => ({}));

    const payload = {
      name: body.name,
      barcode: body.barcode || '',
      code: body.code || '',
      brand: body.brand || '',
      category: body.category || '',
      sale_price: Number(body.sale_price) || 0,
      cost_price: Number(body.cost_price) || 0,
      stock: Number(body.stock) || 0,
      image_url: body.image_url || '',
      description: body.description || '',
      active: body.active !== false,
      show_in_catalog: body.show_in_catalog === true,
      unit: body.unit || 'un',
    };

    if (body.id) {
      const { data, error } = await admin.from('product').update(payload).eq('id', body.id).select().single();
      if (error) return c.json({ error: error.message }, 400);
      if (payload.barcode && payload.name) {
        await persistKnowledge(payload.barcode, { ...payload, source: 'manual' });
      }
      return c.json({ product: data });
    }

    const { data, error } = await admin.from('product').insert(payload).select().single();
    if (error) return c.json({ error: error.message }, 400);
    if (payload.barcode && payload.name) {
      await persistKnowledge(payload.barcode, { ...payload, source: 'manual' });
    }
    return c.json({ product: data }, 201);
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

products.post('/refresh-products-catalog', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);
    const body = await c.req.json().catch(() => ({}));
    const ids = Array.isArray(body.product_ids) ? body.product_ids : null;

    let q = admin.from('product').select('id,name,barcode,brand,category,image_url');
    if (ids?.length) q = q.in('id', ids);
    const { data: list } = await q.limit(500);

    let updated = 0;
    for (const p of list || []) {
      if (!p.barcode) continue;
      const info = await fetchOpenFoodFacts(p.barcode);
      if (!info?.found) continue;
      const patch = {};
      if (!p.image_url && info.image_url) patch.image_url = info.image_url;
      if (!p.brand && info.brand) patch.brand = info.brand;
      if (!p.category && info.category) patch.category = info.category;
      if (Object.keys(patch).length) {
        await admin.from('product').update(patch).eq('id', p.id);
        updated++;
      }
    }
    return c.json({ ok: true, updated, total: (list || []).length });
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

export default products;
