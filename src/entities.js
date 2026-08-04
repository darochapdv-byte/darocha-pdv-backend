import { Hono } from 'hono';
import { admin, userClient, tableFor, restQuery } from './db.js';
import { sanitizeDateFields, sanitizeEntityBody, toBase44Row, toBase44Rows, requireUser, getAllowZeroStock, setAllowZeroStock, ensureCatalogSlug } from './helpers.js';
import { getAccessStatus } from './stripe_ops.js';

const entities = new Hono();

// Entidades de negócio isoladas por usuário (multi-tenant)
const TENANT_ENTITIES = new Set([
  'Product', 'Customer', 'Seller', 'Supplier', 'Courier',
  'Sale', 'CashSession', 'CashMovement', 'CashClosing',
  'StockEntry', 'StockCount', 'StockCountItem', 'StockReservation',
  'Commission', 'FinancialTransaction', 'FixedExpense',
  'DeliveryFee', 'ExpenseCategory', 'AppSettings', 'NFeImport',
  'SaleReturn', 'SaleAuditLog', 'Payroll', 'WishlistItem',
  'Notification', 'ProblemReport', 'Referral', 'Reward',
]);

function clientFrom(c) {
  // Always use admin client to bypass RLS (no per-user policies defined)
  return admin;
}

function parseOrder(order) {
  if (!order) return { column: 'created_at', ascending: false };
  const raw = String(order);
  const desc = raw.startsWith('-');
  let column = raw.replace(/^-/, '') || 'created_at';
  // Frontend às vezes chama list(1, 1) — order numérico não é coluna
  if (/^\d+$/.test(column)) column = 'created_at';
  // map Base44 virtual fields
  const map = { created_date: 'created_at', updated_date: 'updated_at' };
  return { column: map[column] || column, ascending: !desc };
}

function normalizeEntityName(entityName) {
  if (!entityName) return entityName;
  // Aceita Product, product, PRODUCT
  const raw = String(entityName);
  if (TENANT_ENTITIES.has(raw)) return raw;
  const lowerMap = Object.fromEntries([...TENANT_ENTITIES].map((n) => [n.toLowerCase(), n]));
  return lowerMap[raw.toLowerCase()] || raw;
}

function isTenantEntity(entityName) {
  const n = normalizeEntityName(entityName);
  return TENANT_ENTITIES.has(n) || TENANT_ENTITIES.has(entityName);
}

async function assertSubscription(c) {
  const user = await requireUser(c);
  if (!user) return { error: c.json({ error: 'Unauthorized' }, 401) };
  const access = await getAccessStatus(user.id);
  if (!access.allowed) {
    return {
      error: c.json({
        error: 'subscription_required',
        message: access.status === 'trial_expired'
          ? 'Seu período de teste acabou. Assine o plano de R$ 100/mês para continuar.'
          : 'Assinatura inativa. Regularize para continuar usando o sistema.',
        access,
      }, 402),
    };
  }
  return { user, access };
}


/** Aplica filtro de dono (created_by) — cada usuário só vê os próprios dados. */
function applyTenantFilter(q, entityName, user) {
  if (!user?.id || !isTenantEntity(entityName)) return q;
  return q.eq('created_by', user.id);
}


// SSE realtime (deve vir ANTES de /:entity/:id)
entities.get('/:entity/subscribe', async (c) => {
  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');
  return c.stream(async (stream) => {
    await stream.write(`data: ${JSON.stringify({ type: 'connected', entity: c.req.param('entity') })}\n\n`);
    const iv = setInterval(() => {
      stream.write(`data: ${JSON.stringify({ type: 'ping' })}\n\n`).catch(() => clearInterval(iv));
    }, 15000);
  });
});

entities.get('/:entity', async (c) => {
  const entity = c.req.param('entity');
  const table = tableFor(entity);
  const limit = Math.min(Number(c.req.query('limit') || 100), 10000);
  const { column, ascending } = parseOrder(c.req.query('order'));
  const db = clientFrom(c);
  if (!db) return c.json({ error: 'db_unavailable' }, 503);

  const user = await requireUser(c);
  // Multiempresa: entidades de negócio exigem autenticação (sem user = vazamento entre lojas)
  if (isTenantEntity(entity) && !user?.id) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  console.log(`[GET /entities/${entity}] table=${table} user=${user?.id || 'anon'} query=${JSON.stringify(c.req.query())}`);
  let q = db.from(table).select('*');
  q = applyTenantFilter(q, entity, user);

  const allQueries = c.req.queries();
  for (const [k, values] of Object.entries(allQueries)) {
    if (k === 'limit' || k === 'order') continue;

    for (const v of values) {
      if (v === null || v === 'null') q = q.is(k, null);
      else if (String(v).startsWith('in:')) q = q.in(k, String(v).substring(3).split(','));
      else if (String(v).startsWith('neq:')) q = q.neq(k, String(v).substring(4));
      else if (String(v).startsWith('gt:')) q = q.gt(k, String(v).substring(3));
      else if (String(v).startsWith('gte:')) q = q.gte(k, String(v).substring(4));
      else if (String(v).startsWith('lt:')) q = q.lt(k, String(v).substring(3));
      else if (String(v).startsWith('lte:')) q = q.lte(k, String(v).substring(4));
      else if (String(v).startsWith('like:')) q = q.like(k, String(v).substring(5));
      else if (String(v).startsWith('ilike:')) q = q.ilike(k, String(v).substring(6));
      else q = q.eq(k, v);
    }
  }
  q = q.order(column, { ascending }).limit(limit);
  const { data, error } = await q;
  if (error) return c.json({ error: error.message }, 400);
  let rows = toBase44Rows(data);
  // Wishlist: fallback rest se RLS do client esconder linhas
  if (normalizeEntityName(entity) === 'WishlistItem' && user?.id && (!rows || rows.length === 0)) {
    try {
      const rowsRest = await restQuery(
        `wishlist_item?created_by=eq.${encodeURIComponent(user.id)}&select=*&order=created_at.desc&limit=${limit}`
      );
      if (Array.isArray(rowsRest) && rowsRest.length) rows = toBase44Rows(rowsRest);
    } catch (e) {
      console.warn('wishlist list rest', e.message || e);
    }
  }
  if (entity === 'AppSettings' && Array.isArray(rows)) {
    const allow = await getAllowZeroStock();
    const enriched = [];
    for (const r of rows) {
      const ownerId = r.created_by || user?.id || null;
      let catalog_slug = null;
      if (ownerId) {
        try {
          catalog_slug = await ensureCatalogSlug(ownerId, r.company_name || user?.company_name || null);
        } catch (e) {
          console.warn('catalog_slug enrich', e.message || e);
        }
      }
      const frontendBase = process.env.FRONTEND_URL || 'https://dist-ten-mu-12.vercel.app';
      const catalog_url = catalog_slug
        ? `${frontendBase.replace(/\/$/, '')}/catalogo?loja=${encodeURIComponent(catalog_slug)}`
        : null;
      enriched.push({ ...r, allow_zero_stock: allow, catalog_slug, catalog_url });
    }
    rows = enriched;
  }
  return c.json(rows);
});

entities.get('/:entity/:id', async (c) => {
  const entity = c.req.param('entity');
  const table = tableFor(entity);
  const db = clientFrom(c);
  if (!db) return c.json({ error: 'db_unavailable' }, 503);

  const user = await requireUser(c);
  if (isTenantEntity(entity) && !user?.id) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  let q = db.from(table).select('*').eq('id', c.req.param('id'));
  q = applyTenantFilter(q, entity, user);

  let { data, error } = await q.maybeSingle();
  if ((error || !data) && normalizeEntityName(entity) === 'WishlistItem' && user?.id) {
    try {
      const rows = await restQuery(
        `wishlist_item?id=eq.${encodeURIComponent(c.req.param('id'))}&created_by=eq.${encodeURIComponent(user.id)}&select=*&limit=1`
      );
      data = Array.isArray(rows) ? rows[0] : rows;
      error = null;
    } catch (e) {
      /* keep previous */
    }
  }
  if (error) return c.json({ error: error.message }, 400);
  if (!data) return c.json({ error: 'not_found' }, 404);
  return c.json(toBase44Row(data));
});

entities.post('/:entity/query', async (c) => {
  const entity = c.req.param('entity');
  const table = tableFor(entity);
  const body = await c.req.json().catch(() => ({}));
  const query = body.query || {};
  const limit = Math.min(Number(body.limit || 100), 10000);
  const { column, ascending } = parseOrder(body.order);
  const db = clientFrom(c);
  if (!db) return c.json({ error: 'db_unavailable' }, 503);

  const user = await requireUser(c);
  if (isTenantEntity(entity) && !user?.id) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  let q = db.from(table).select('*');
  q = applyTenantFilter(q, entity, user);

  for (const [k, v] of Object.entries(query)) {
    if (v === null || v === 'null') q = q.is(k, null);
    else if (Array.isArray(v)) q = q.in(k, v);
    else if (String(v).startsWith('in:')) q = q.in(k, String(v).substring(3).split(','));
    else if (String(v).startsWith('neq:')) q = q.neq(k, String(v).substring(4));
    else if (String(v).startsWith('gt:')) q = q.gt(k, String(v).substring(3));
    else if (String(v).startsWith('gte:')) q = q.gte(k, String(v).substring(4));
    else if (String(v).startsWith('lt:')) q = q.lt(k, String(v).substring(3));
    else if (String(v).startsWith('lte:')) q = q.lte(k, String(v).substring(4));
    else if (String(v).startsWith('like:')) q = q.like(k, String(v).substring(5));
    else if (String(v).startsWith('ilike:')) q = q.ilike(k, String(v).substring(6));
    else q = q.eq(k, v);
  }
  q = q.order(column, { ascending }).limit(limit);
  const { data, error } = await q;
  if (error) return c.json({ error: error.message }, 400);
  return c.json(toBase44Rows(data));
});


/** Remove campos que costumam não existir em schemas legados */
function stripUnknownForEntity(entityName, body) {
  const ent = normalizeEntityName(entityName);
  const out = { ...(body || {}) };
  if (ent === 'Notification') {
    // schema real: title, message, type, sale_id, created_by, read...
    delete out.product_id;
    delete out.productId;
  }
  if (ent === 'SaleAuditLog') {
    // map description → note/details se vier do front
    if (out.description != null && out.note == null && out.details == null) {
      out.note = String(out.description);
      out.details = String(out.description);
    }
    delete out.description;
  }
  if (ent === 'Seller') {
    // coluna active não existe — usa status
    if (out.active === true && !out.status) out.status = 'ativo';
    if (out.active === false && !out.status) out.status = 'inativo';
    delete out.active;
  }
  if (ent === 'WishlistItem') {
    if (out.status) out.status = String(out.status).toLowerCase();
  }
  return out;
}

async function insertRowBypass(table, body) {
  // 1) supabase-js admin
  if (admin) {
    const { data, error } = await admin.from(table).insert(body).select().single();
    if (!error && data) return { data, error: null };
    if (error) {
      console.warn(`insert ${table} via js:`, error.message);
      // 2) retry sem colunas problemáticas comuns
      const msg = error.message || '';
      const colMatch = msg.match(/Could not find the '([^']+)' column/i);
      if (colMatch) {
        const cleaned = { ...body };
        delete cleaned[colMatch[1]];
        const retry = await admin.from(table).insert(cleaned).select().single();
        if (!retry.error && retry.data) return { data: retry.data, error: null };
        if (retry.error) console.warn(`insert ${table} retry:`, retry.error.message);
      }
    }
  }
  // 3) PostgREST direto (contorna alguns casos de RLS/service key)
  try {
    const inserted = await restQuery(table, {
      method: 'POST',
      body,
      prefer: 'return=representation',
    });
    const row = Array.isArray(inserted) ? inserted[0] : inserted;
    if (row) return { data: row, error: null };
  } catch (e) {
    console.warn(`insert ${table} via rest:`, e.message || e);
    return { data: null, error: e };
  }
  return { data: null, error: new Error('insert_failed') };
}

entities.post('/:entity', async (c) => {
  const entity = c.req.param('entity');
  const table = tableFor(entity);
  let body = await c.req.json();
  body = sanitizeEntityBody(body);
  const db = clientFrom(c);
  if (!db) return c.json({ error: 'db_unavailable' }, 503);

  // Bloqueia escrita se trial acabou / sem assinatura
  if (isTenantEntity(entity) && entity !== 'AppSettings') {
    const gate = await assertSubscription(c);
    if (gate.error) return gate.error;
  }

  let allowZeroStockSaved = null;
  if (entity === 'AppSettings' && Object.prototype.hasOwnProperty.call(body, 'allow_zero_stock')) {
    allowZeroStockSaved = body.allow_zero_stock === true;
    await setAllowZeroStock(allowZeroStockSaved);
    delete body.allow_zero_stock;
  }

  // Garante ownership no cadastro
  const user = await requireUser(c);
  if (isTenantEntity(entity) && !user?.id) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  if (user && isTenantEntity(entity)) {
    body.created_by = user.id;
  }

  // Em insert, deixa o banco gerar o id
  delete body.id;
  body = stripUnknownForEntity(entity, body);

  const { data, error } = await insertRowBypass(table, body);
  if (error || !data) {
    const msg = (error && error.message) || 'insert_failed';
    // SaleAuditLog / Wishlist: soft-fail não quebra PDV
    const soft = normalizeEntityName(entity) === 'SaleAuditLog';
    if (soft) {
      console.warn(`${entity} insert soft-fail:`, msg);
      return c.json({ ok: true, skipped: true, reason: msg, ...body }, 201);
    }
    return c.json({ error: msg }, 400);
  }
  let row = toBase44Row(data);
  // Wishlist: verifica persistência e ownership (RLS às vezes engole SELECT depois do INSERT)
  if (normalizeEntityName(entity) === 'WishlistItem' && user?.id) {
    try {
      if (row?.id) {
        // força created_by
        try {
          await restQuery(
            `wishlist_item?id=eq.${encodeURIComponent(row.id)}`,
            { method: 'PATCH', body: { created_by: user.id, status: row.status || 'aguardando' }, prefer: 'return=representation' }
          );
        } catch (_) {}
        let verified = null;
        try {
          const rows = await restQuery(
            `wishlist_item?id=eq.${encodeURIComponent(row.id)}&select=*&limit=1`
          );
          verified = Array.isArray(rows) ? rows[0] : rows;
        } catch (_) {}
        if (!verified) {
          // reinsert via rest puro
          const payload = {
            product_id: row.product_id || body.product_id || null,
            product_name: row.product_name || body.product_name || null,
            customer_name: row.customer_name || body.customer_name || null,
            customer_phone: row.customer_phone || body.customer_phone || null,
            status: row.status || body.status || 'aguardando',
            created_by: user.id,
          };
          const inserted = await restQuery('wishlist_item', {
            method: 'POST',
            body: payload,
            prefer: 'return=representation',
          });
          verified = Array.isArray(inserted) ? inserted[0] : inserted;
        }
        if (verified) row = toBase44Row(verified);
      }
    } catch (e) {
      console.warn('wishlist verify', e.message || e);
    }
  }
  if (entity === 'AppSettings') {
    row.allow_zero_stock = allowZeroStockSaved ?? (await getAllowZeroStock());
  }
  return c.json(row, 201);
});

entities.patch("/:entity/:id", async (c) => {
  const entity = c.req.param("entity");
  const table = tableFor(entity);
  let body = await c.req.json();
  body = sanitizeEntityBody(body);
  // Impede troca de dono pelo cliente
  delete body.created_by;
  delete body.id;

  // Política global "vender sem estoque" (pode não existir como coluna)
  let allowZeroStockSaved = null;
  if (entity === 'AppSettings' && Object.prototype.hasOwnProperty.call(body, 'allow_zero_stock')) {
    allowZeroStockSaved = body.allow_zero_stock === true;
    await setAllowZeroStock(allowZeroStockSaved);
    delete body.allow_zero_stock;
  }

  const db = clientFrom(c);
  if (!db) return c.json({ error: 'db_unavailable' }, 503);

  const user = await requireUser(c);
  if (isTenantEntity(entity) && !user?.id) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  body = stripUnknownForEntity(entity, body);

  // Entrada de estoque: se Product.stock subir, libera wishlist + notifica
  let prevStock = null;
  if (normalizeEntityName(entity) === 'Product' && body.stock != null && admin) {
    try {
      let pq = admin.from('product').select('id,name,stock').eq('id', c.req.param('id'));
      pq = applyTenantFilter(pq, entity, user);
      const { data: prev } = await pq.maybeSingle();
      if (prev) prevStock = Number(prev.stock) || 0;
    } catch (_) {}
  }

  let q = db.from(table).update(body).eq('id', c.req.param('id'));
  q = applyTenantFilter(q, entity, user);

  let { data, error } = await q.select().single();
  // fallback rest em caso de coluna desconhecida
  if (error) {
    const colMatch = (error.message || '').match(/Could not find the '([^']+)' column/i);
    if (colMatch) {
      delete body[colMatch[1]];
      q = db.from(table).update(body).eq('id', c.req.param('id'));
      q = applyTenantFilter(q, entity, user);
      ({ data, error } = await q.select().single());
    }
  }
  if (error) return c.json({ error: error.message }, 400);
  const row = toBase44Row(data);

  if (
    normalizeEntityName(entity) === 'Product' &&
    prevStock != null &&
    body.stock != null &&
    Number(body.stock) > prevStock &&
    user?.id
  ) {
    try {
      const pname = (row.name || '').trim().toLowerCase();
      const productId = row.id || c.req.param('id');
      let waiting = [];
      // Preferir PostgREST (mais confiável com service key em algumas tabelas)
      try {
        const q1 = `wishlist_item?created_by=eq.${encodeURIComponent(user.id)}&status=eq.aguardando&select=id,product_id,product_name,status,created_by&limit=200`;
        const rows = await restQuery(q1);
        waiting = Array.isArray(rows) ? rows : [];
      } catch (e) {
        if (admin) {
          const { data } = await admin
            .from('wishlist_item')
            .select('id,product_id,product_name,status,created_by')
            .eq('created_by', user.id)
            .eq('status', 'aguardando')
            .limit(200);
          waiting = data || [];
        }
      }
      const matches = (waiting || []).filter((w) => {
        if (w.product_id && productId && String(w.product_id) === String(productId)) return true;
        const wn = (w.product_name || '').trim().toLowerCase();
        return wn && pname && wn === pname;
      });
      if (matches.length) {
        try {
          await restQuery(
            `wishlist_item?id=in.(${matches.map((m) => m.id).join(',')})`,
            { method: 'PATCH', body: { status: 'disponivel' }, prefer: 'return=minimal' }
          );
        } catch (e) {
          if (admin) {
            await admin.from('wishlist_item').update({ status: 'disponivel' }).in('id', matches.map((m) => m.id));
          }
        }
      }
      await insertRowBypass('notification', {
        title: 'Produto disponível',
        message: `${row.name || 'Produto'} voltou ao estoque (${matches.length} aviso(s) na lista de espera).`,
        type: 'estoque_disponivel',
        created_by: user.id,
      });
    } catch (e) {
      console.warn('wishlist stock notify', e.message || e);
    }
  }

  if (entity === 'AppSettings') {
    row.allow_zero_stock = allowZeroStockSaved ?? (await getAllowZeroStock());
  }
  return c.json(row);
});

entities.delete('/:entity/:id', async (c) => {
  const entity = c.req.param('entity');
  const table = tableFor(entity);
  const db = clientFrom(c);
  if (!db) return c.json({ error: 'db_unavailable' }, 503);

  const user = await requireUser(c);
  if (isTenantEntity(entity) && !user?.id) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  let q = db.from(table).delete().eq('id', c.req.param('id'));
  q = applyTenantFilter(q, entity, user);

  const { error } = await q;
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ ok: true });
});

entities.post("/:entity/bulk-update", async (c) => {
  const entity = c.req.param("entity");
  const table = tableFor(entity);
  let { items } = await c.req.json();
  items = (items || []).map((item) => sanitizeEntityBody(item));
  const db = clientFrom(c) || admin;
  if (!db) return c.json({ error: 'db_unavailable' }, 503);
  if (!Array.isArray(items) || items.length === 0) return c.json([]);

  const user = await requireUser(c);
  if (isTenantEntity(entity) && !user?.id) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const results = [];
  for (const item of items) {
    const { id, ...rest } = item;
    if (!id) continue;
    delete rest.created_by;
    let q = db.from(table).update(rest).eq('id', id);
    q = applyTenantFilter(q, entity, user);
    const { data, error } = await q.select().single();
    if (error) return c.json({ error: error.message }, 400);
    results.push(toBase44Row(data));
  }
  return c.json(results);
});

entities.post("/:entity/bulk-create", async (c) => {
  const entity = c.req.param("entity");
  const table = tableFor(entity);
  let { items } = await c.req.json();
  items = (items || []).map((item) => {
    const row = sanitizeEntityBody(item);
    delete row.id;
    return row;
  });
  const db = clientFrom(c);
  if (!db) return c.json({ error: 'db_unavailable' }, 503);

  const user = await requireUser(c);
  if (isTenantEntity(entity) && !user?.id) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  if (user && isTenantEntity(entity)) {
    items = items.map((item) => ({ ...item, created_by: user.id }));
  }

  const { data, error } = await db.from(table).insert(items).select();
  if (error) return c.json({ error: error.message }, 400);
  return c.json(toBase44Rows(data), 201);
});

export default entities;
