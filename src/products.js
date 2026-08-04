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

    // Frontend envia { product: {...}, editing_id } — também aceita payload flat
    const src = body.product && typeof body.product === 'object' ? body.product : body;
    const editingId = body.editing_id || body.id || src.id || null;

    const payload = {
      name: src.name,
      barcode: src.barcode || '',
      code: src.code || src.barcode || '',
      brand: src.brand || '',
      category: src.category || '',
      sale_price: Number(src.sale_price) || 0,
      // coluna real no Supabase é "cost" (não cost_price)
      cost: Number(src.cost ?? src.cost_price) || 0,
      stock: Number(src.stock) || 0,
      min_stock: Number(src.min_stock) || 0,
      image_url: src.image_url || src.image || src.photo || src.photo_url || '',
      description: src.description || '',
      active: src.active !== false,
      show_in_catalog: src.show_in_catalog === true,
      unit: src.unit || 'un',
    };

    // Multi-tenant: grava ownership; no update não apaga created_by existente
    if (!editingId) {
      payload.created_by = user.id;
    }

    if (editingId) {
      let uq = admin.from('product').update(payload).eq('id', editingId);
      // se produto órfão (created_by null), permite o dono reivindicar
      // admin client já bypassa RLS; ainda assim filtramos ownership quando possível
      const { data, error } = await uq.select().single();
      if (error) return c.json({ error: error.message }, 400);
      // garante ownership se estava null
      if (data && !data.created_by && user.id) {
        const { data: fixed } = await admin
          .from('product')
          .update({ created_by: user.id })
          .eq('id', editingId)
          .select()
          .single();
        if (fixed) {
          if (payload.barcode && payload.name) {
            await persistKnowledge(payload.barcode, { ...payload, source: 'manual' });
          }
          return c.json({ product: fixed, success: true, updated: true, id: editingId });
        }
      }
      if (payload.barcode && payload.name) {
        await persistKnowledge(payload.barcode, { ...payload, source: 'manual' });
      }
      return c.json({ product: data, success: true, updated: true, id: editingId });
    }

    const { data, error } = await admin.from('product').insert(payload).select().single();
    if (error) {
      // Duplicata de barcode/código: se for órfão ou já do usuário, atualiza em vez de falhar
      const msg = String(error.message || error.code || '');
      const isDup =
        error.code === '23505' ||
        /duplicate|unique|já exist/i.test(msg);
      if (isDup) {
        let existing = null;
        if (payload.barcode) {
          const { data: byBc } = await admin
            .from('product')
            .select('*')
            .eq('barcode', payload.barcode)
            .limit(1)
            .maybeSingle();
          existing = byBc;
        }
        if (!existing && payload.code) {
          const { data: byCode } = await admin
            .from('product')
            .select('*')
            .eq('code', payload.code)
            .limit(1)
            .maybeSingle();
          existing = byCode;
        }
        if (!existing && payload.name) {
          const { data: byName } = await admin
            .from('product')
            .select('*')
            .eq('name', payload.name)
            .eq('created_by', user.id)
            .limit(1)
            .maybeSingle();
          existing = byName;
        }
        if (existing) {
          const owner = existing.created_by;
          if (owner && owner !== user.id) {
            return c.json({
              error: 'Este produto (código de barras) já pertence a outra loja. Use outro código ou edite o produto na lista.',
              code: 'product_owned_by_other',
            }, 409);
          }
          const claim = { ...payload, created_by: user.id };
          const { data: updated, error: uErr } = await admin
            .from('product')
            .update(claim)
            .eq('id', existing.id)
            .select()
            .single();
          if (uErr) return c.json({ error: uErr.message }, 400);
          if (payload.barcode && payload.name) {
            await persistKnowledge(payload.barcode, { ...payload, source: 'manual' });
          }
          return c.json({
            product: updated,
            success: true,
            updated: true,
            claimed: !owner,
            id: existing.id,
            message: owner ? 'Produto atualizado.' : 'Produto encontrado e vinculado à sua loja.',
          });
        }
      }
      return c.json({ error: error.message }, 400);
    }
    if (payload.barcode && payload.name) {
      await persistKnowledge(payload.barcode, { ...payload, source: 'manual' });
    }
    return c.json({ product: data, success: true, created: true }, 201);
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


// Reivindica produtos órfãos (created_by null) para o usuário logado — corrige bug do save-product
products.post('/repair-product-ownership', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);
    const { data: orphans, error: qErr } = await admin
      .from('product')
      .select('id,name,created_at')
      .is('created_by', null);
    if (qErr) return c.json({ error: qErr.message }, 400);
    if (!orphans?.length) return c.json({ ok: true, fixed: 0, message: 'Nenhum produto órfão' });
    const ids = orphans.map((p) => p.id);
    const { error: uErr } = await admin
      .from('product')
      .update({ created_by: user.id })
      .in('id', ids);
    if (uErr) return c.json({ error: uErr.message }, 400);
    return c.json({ ok: true, fixed: ids.length, products: orphans.map((p) => p.name) });
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

export default products;

