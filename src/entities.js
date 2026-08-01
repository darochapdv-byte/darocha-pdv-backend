import { Hono } from 'hono';
import { admin, userClient, tableFor } from './db.js';
import { sanitizeDateFields } from './helpers.js';

const entities = new Hono();

function clientFrom(c) {
  // Always use admin client to bypass RLS (no per-user policies defined)
  return admin;
}

function parseOrder(order) {
  if (!order) return { column: 'created_at', ascending: false };
  const desc = String(order).startsWith('-');
  const column = String(order).replace(/^-/, '') || 'created_at';
  // map Base44 virtual fields
  const map = { created_date: 'created_at', updated_date: 'updated_at' };
  return { column: map[column] || column, ascending: !desc };
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

  const { data, error } = await db.from(table).select('*').order(column, { ascending }).limit(limit);
  if (error) return c.json({ error: error.message }, 400);
  return c.json(data);
});

entities.get('/:entity/:id', async (c) => {
  const table = tableFor(c.req.param('entity'));
  const db = clientFrom(c);
  if (!db) return c.json({ error: 'db_unavailable' }, 503);
  const { data, error } = await db.from(table).select('*').eq('id', c.req.param('id')).maybeSingle();
  if (error) return c.json({ error: error.message }, 400);
  if (!data) return c.json({ error: 'not_found' }, 404);
  return c.json(data);
});

entities.post('/:entity/query', async (c) => {
  const table = tableFor(c.req.param('entity'));
  const body = await c.req.json().catch(() => ({}));
  const query = body.query || {};
  const limit = Math.min(Number(body.limit || 100), 1000);
  const { column, ascending } = parseOrder(body.order);
  const db = clientFrom(c);
  if (!db) return c.json({ error: 'db_unavailable' }, 503);

  let q = db.from(table).select('*');
  for (const [k, v] of Object.entries(query)) {
    if (v === null) q = q.is(k, null);
    else if (Array.isArray(v)) q = q.in(k, v);
    else q = q.eq(k, v);
  }
  q = q.order(column, { ascending }).limit(limit);
  const { data, error } = await q;
  if (error) return c.json({ error: error.message }, 400);
  return c.json(data);
});

entities.post('/:entity', async (c) => {
  const table = tableFor(c.req.param('entity'));
  let body = await c.req.json();
  body = sanitizeDateFields(body);
  const db = clientFrom(c);
  if (!db) return c.json({ error: 'db_unavailable' }, 503);
  const { data, error } = await db.from(table).insert(body).select().single();
  if (error) return c.json({ error: error.message }, 400);
  return c.json(data, 201);
});

entities.patch("/:entity/:id", async (c) => {
  const table = tableFor(c.req.param("entity"));
  let body = await c.req.json();
  body = sanitizeDateFields(body);
  const db = clientFrom(c);
  if (!db) return c.json({ error: 'db_unavailable' }, 503);
  const { data, error } = await db.from(table).update(body).eq('id', c.req.param('id')).select().single();
  if (error) return c.json({ error: error.message }, 400);
  return c.json(data);
});

entities.delete('/:entity/:id', async (c) => {
  const table = tableFor(c.req.param('entity'));
  const db = clientFrom(c);
  if (!db) return c.json({ error: 'db_unavailable' }, 503);
  const { error } = await db.from(table).delete().eq('id', c.req.param('id'));
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ ok: true });
});

entities.post("/:entity/bulk-update", async (c) => {
  const table = tableFor(c.req.param("entity"));
  let { items } = await c.req.json();
  items = items.map(item => sanitizeDateFields(item));
  const db = clientFrom(c) || admin;
  if (!db) return c.json({ error: 'db_unavailable' }, 503);
  if (!Array.isArray(items) || items.length === 0) return c.json([]);

  const results = [];
  for (const item of items) {
    const { id, ...rest } = item;
    if (!id) continue;
    const { data, error } = await db.from(table).update(rest).eq('id', id).select().single();
    if (error) return c.json({ error: error.message }, 400);
    results.push(data);
  }
  return c.json(results);
});

entities.post("/:entity/bulk-create", async (c) => {
  const table = tableFor(c.req.param("entity"));
  let { items } = await c.req.json();
  items = items.map(item => sanitizeDateFields(item));
  const db = clientFrom(c);
  if (!db) return c.json({ error: 'db_unavailable' }, 503);
  const { data, error } = await db.from(table).insert(items).select();
  if (error) return c.json({ error: error.message }, 400);
  return c.json(data, 201);
});

export default entities;
