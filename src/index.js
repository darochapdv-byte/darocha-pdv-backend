
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import auth from './auth.js';
import entities from './entities.js';
import functions from './functions.js';
import catalog from './catalog.js';
import catalogExtra from './catalog_extra.js';
import products from './products.js';
import stock from './stock.js';
import adminOps from './admin_ops.js';
import stripeOps from './stripe_ops.js';
import nfe from './nfe.js';
import integration from './integration.js';
import { admin, useLocal } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = new Hono();

app.use(
  '*',
  cors({
    origin: (origin) => origin || '*',
    allowHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'stripe-signature'],
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  })
);

// Arquivos enviados (modo local)
app.get('/uploads/:file', async (c) => {
  const name = c.req.param('file');
  if (!name || name.includes('..')) return c.json({ error: 'invalid' }, 400);
  const fp = path.join(UPLOAD_DIR, name);
  if (!fs.existsSync(fp)) return c.json({ error: 'not_found' }, 404);
  const buf = fs.readFileSync(fp);
  const ext = name.split('.').pop()?.toLowerCase();
  const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf' };
  return new Response(buf, { headers: { 'Content-Type': types[ext] || 'application/octet-stream' } });
});

app.get('/health', async (c) => {
  const started = Date.now();
  let dbOk = !!admin;
  let dbError = null;
  if (admin && !useLocal) {
    try {
      // Ping leve no banco — confirma que Supabase responde
      const { error } = await admin.from('app_settings').select('id').limit(1);
      if (error) {
        dbOk = false;
        dbError = error.message;
      }
    } catch (e) {
      dbOk = false;
      dbError = e.message || String(e);
    }
  }
  const body = {
    ok: dbOk,
    service: 'darocha-pdv-backend',
    db: dbOk,
    mode: useLocal ? 'local' : 'supabase',
    time: new Date().toISOString(),
    latency_ms: Date.now() - started,
  };
  if (dbError) body.db_error = dbError;
  return c.json(body, dbOk ? 200 : 503);
});

app.onError((err, c) => {
  console.error('unhandled', err?.message || err);
  return c.json({ error: 'internal_error', message: err?.message || 'Erro interno' }, 500);
});

app.notFound((c) => c.json({ error: 'not_found' }, 404));

app.route('/auth', auth);
app.route('/entities', entities);
app.route('/functions', catalog);
app.route('/functions', catalogExtra);
app.route('/functions', products);
app.route('/functions', stock);
app.route('/functions', adminOps);
app.route('/functions', stripeOps);
app.route('/functions', nfe);
app.route('/functions', integration);
app.route('/functions', functions);

app.post('/integrations/upload', async (c) => {
  try {
    const form = await c.req.parseBody();
    // Frontend pode enviar como file, image, photo ou arquivo
    const file = form.file || form.image || form.photo || form.arquivo;
    if (!file || typeof file === 'string') {
      return c.json({ error: 'file_required', message: 'Envie o arquivo no campo file/image/photo' }, 400);
    }
    const buf = Buffer.from(await file.arrayBuffer());
    if (!buf.length) return c.json({ error: 'empty_file' }, 400);

    const originalName = file.name || 'upload.bin';
    const ext = (originalName.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
    const safe = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const contentType =
      file.type ||
      (ext === 'png'
        ? 'image/png'
        : ext === 'jpg' || ext === 'jpeg'
          ? 'image/jpeg'
          : ext === 'webp'
            ? 'image/webp'
            : 'application/octet-stream');

    if (useLocal || !process.env.SUPABASE_URL) {
      const dest = path.join(UPLOAD_DIR, safe);
      fs.writeFileSync(dest, buf);
      const base = process.env.APP_URL || `http://localhost:${process.env.PORT || 8787}`;
      const file_url = `${base}/uploads/${safe}`;
      return c.json({ file_url, url: file_url, image_url: file_url });
    }

    // Upload via Storage REST API (supabase-js + sb_secret_* esbarra em RLS no storage)
    const storagePath = `uploads/${safe}`;
    const supabaseUrl = process.env.SUPABASE_URL.replace(/\/$/, '');
    const serviceKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    const uploadRes = await fetch(
      `${supabaseUrl}/storage/v1/object/public/${storagePath}`,
      {
        method: 'POST',
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': contentType,
          'x-upsert': 'true',
        },
        body: buf,
      }
    );
    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      console.error('storage upload error', uploadRes.status, errText);
      let msg = errText;
      try {
        const j = JSON.parse(errText);
        msg = j.message || j.error || errText;
      } catch {
        /* keep text */
      }
      return c.json({ error: msg }, 400);
    }
    const file_url = `${supabaseUrl}/storage/v1/object/public/public/${storagePath}`;
    // Resposta compatível com vários frontends
    return c.json({ file_url, url: file_url, image_url: file_url });
  } catch (e) {
    console.error('upload error', e);
    return c.json({ error: e.message }, 500);
  }
});

app.post('/integrations/llm', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const prompt = body.prompt || body.message || '';
  const schema = body.response_json_schema;
  const systemExtra = schema
    ? `Responda APENAS com JSON válido conforme o schema: ${JSON.stringify(schema)}`
    : 'Você é o assistente do Darocha PDV (ponto de venda brasileiro).';

  // OpenAI
  if (process.env.OPENAI_API_KEY) {
    try {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemExtra },
            { role: 'user', content: prompt },
          ],
          ...(schema ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (r.ok) {
        const j = await r.json();
        const text = j.choices?.[0]?.message?.content || '';
        if (schema) {
          try { return c.json(JSON.parse(text)); } catch { return c.json({ raw: text }); }
        }
        return c.json({ response: text, text });
      }
    } catch (e) {
      console.error('openai', e.message);
    }
  }

  // Google Gemini (compatível com o que a Base44 usava)
  if (process.env.GEMINI_API_KEY) {
    try {
      const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${systemExtra}

${prompt}` }] }],
          generationConfig: schema ? { responseMimeType: 'application/json' } : undefined,
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (r.ok) {
        const j = await r.json();
        const text = j.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (schema) {
          try { return c.json(JSON.parse(text)); } catch { return c.json({ raw: text }); }
        }
        return c.json({ response: text, text });
      }
    } catch (e) {
      console.error('gemini', e.message);
    }
  }

  return c.json({
    error: 'llm_not_configured',
    message: 'Defina OPENAI_API_KEY ou GEMINI_API_KEY no backend/.env',
    echo: String(prompt).slice(0, 80),
  }, 501);
});

app.post('/integrations/email', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  // Stub: log + opcional Resend/SMTP
  console.log('[email]', body.to, body.subject);
  if (process.env.RESEND_API_KEY && body.to) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: process.env.EMAIL_FROM || 'Darocha PDV <onboarding@resend.dev>',
          to: [body.to],
          subject: body.subject || 'Darocha PDV',
          html: body.body || body.html || '',
        }),
      });
      const data = await r.json();
      if (!r.ok) return c.json({ error: data }, 400);
      return c.json({ ok: true, id: data.id });
    } catch (e) {
      return c.json({ error: e.message }, 500);
    }
  }
  return c.json({ ok: true, stub: true, message: 'E-mail simulado (configure RESEND_API_KEY)' });
});

const port = Number(process.env.PORT || 8787);
console.log(`Darocha PDV backend on :${port} (${useLocal ? 'local' : 'supabase'})`);
serve({ fetch: app.fetch, port });
