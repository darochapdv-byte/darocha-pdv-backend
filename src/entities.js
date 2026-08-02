import { Hono } from 'hono';
import { admin, userClient, tableFor } from './db.js';
import { sanitizeDateFields, sanitizeEntityBody, toBase44Row, toBase44Rows, requireUser, getAllowZeroStock, setAllowZeroStock } from './helpers.js';

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

function isTenantEntity(entityName) {
  return TENANT_ENTITIES.has(entityName);
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
  const limit = Math.min(Number(c.req.query('limit') || 100), 1000);
  const { column, ascending } = parseOrder(c.req.query('order'));
  const db = clientFrom(c);
  if (!db) return c.json({ error: 'db_unavailable' }, 503);

  const user = await requireUser(c);

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
  if (entity === 'AppSettings' && Array.isArray(rows)) {
    const allow = await getAllowZeroStock();
    rows = rows.map((r) => ({ ...r, allow_zero_stock: allow }));
  }
  return c.json(rows);
});

entities.get('/:entity/:id', async (c) => {
  const entity = c.req.param('entity');
  const table = tableFor(entity);
  const db = clientFrom(c);
  if (!db) return c.json({ error: 'db_unavailable' }, 503);

  const user = await requireUser(c);
  let q = db.from(table).select('*').eq('id', c.req.param('id'));
  q = applyTenantFilter(q, entity, user);

  const { data, error } = await q.maybeSingle();
  if (error) return c.json({ error: error.message }, 400);
  if (!data) return c.json({ error: 'not_found' }, 404);
  return c.json(toBase44Row(data));
});

entities.post('/:entity/query', async (c) => {
  const entity = c.req.param('entity');
  const table = tableFor(entity);
  const body = await c.req.json().catch(() => ({}));
  const query = body.query || {};
  const limit = Math.min(Number(body.limit || 100), 1000);
  const { column, ascending } = parseOrder(body.order);
  const db = clientFrom(c);
  if (!db) return c.json({ error: 'db_unavailable' }, 503);

  const user = await requireUser(c);
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

entities.post('/:entity', async (c) => {
  const entity = c.req.param('entity');
  const table = tableFor(entity);
  let body = await c.req.json();
  body = sanitizeEntityBody(body);
  const db = clientFrom(c);
  if (!db) return c.json({ error: 'db_unavailable' }, 503);

  let allowZeroStockSaved = null;
  if (entity === 'AppSettings' && Object.prototype.hasOwnProperty.call(body, 'allow_zero_stock')) {
    allowZeroStockSaved = body.allow_zero_stock === true;
    await setAllowZeroStock(allowZeroStockSaved);
    delete body.allow_zero_stock;
  }

  // Garante ownership no cadastro
  const user = await requireUser(c);
  if (user && isTenantEntity(entity)) {
    body.created_by = user.id;
  }

  // Em insert, deixa o banco gerar o id
  delete body.id;

  const { data, error } = await db.from(table).insert(body).select().single();
  if (error) return c.json({ error: error.message }, 400);
  const row = toBase44Row(data);
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
  let q = db.from(table).update(body).eq('id', c.req.param('id'));
  q = applyTenantFilter(q, entity, user);

  const { data, error } = await q.select().single();
  if (error) return c.json({ error: error.message }, 400);
  const row = toBase44Row(data);
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
  if (user && isTenantEntity(entity)) {
    items = items.map((item) => ({ ...item, created_by: user.id }));
  }

  const { data, error } = await db.from(table).insert(items).select();
  if (error) return c.json({ error: error.message }, 400);
  return c.json(toBase44Rows(data), 201);
});

export default entities;
