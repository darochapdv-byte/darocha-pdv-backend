import { Hono } from 'hono';
import { admin } from './db.js';
import { requireUser } from './helpers.js';
import { encryptSecret, decryptSecret } from './fiscal_helpers.js';

const ai = new Hono();
const KEY = '__darocha_ai';
const LOG = 'ai_message';

function maskKey(k) {
  const s = String(k || '');
  if (s.length < 8) return s ? '••••' : '';
  return `••••••••••••${s.slice(-4)}`;
}

function publicCfg(raw) {
  if (!raw || typeof raw !== 'object') {
    return { enabled: false, provider: 'openai', model: '', connected: false };
  }
  return {
    enabled: raw.enabled === true,
    auto_reply: raw.auto_reply !== false,
    provider: raw.provider || 'openai',
    model: raw.model || (raw.provider === 'gemini' ? 'gemini-2.0-flash' : 'gpt-4o-mini'),
    agent_name: raw.agent_name || 'Atendente',
    personality: raw.personality || 'amigavel',
    instructions: raw.instructions || '',
    allow_stock: raw.allow_stock !== false,
    allow_price: raw.allow_price !== false,
    allow_delivery: raw.allow_delivery !== false,
    allow_order: raw.allow_order === true,
    transfer_human: raw.transfer_human !== false,
    channels: { whatsapp: !!raw.wa_connected, instagram: !!raw.ig_connected },
    wa_number: raw.wa_number || '',
    wa_phone_id: raw.wa_phone_id || '',
    ig_account: raw.ig_account || '',
    ig_id: raw.ig_id || '',
    webhook: '/functions/ai-webhook',
    has_key: !!raw.api_key_encrypted,
    key_hint: raw.key_hint || '',
    connected: !!(raw.enabled && raw.api_key_encrypted),
  };
}

async function loadRow(userId) {
  if (!admin || !userId) return { row: null, ai: null };
  const { data } = await admin
    .from('app_settings')
    .select('id,created_by,company_name,role_payment_methods')
    .eq('created_by', userId)
    .order('created_at', { ascending: false })
    .limit(8);
  const row = (data || [])[0] || null;
  return { row, ai: row?.role_payment_methods?.[KEY] || null };
}

async function saveAi(userId, patch) {
  const { row, ai: cur } = await loadRow(userId);
  const next = { ...(cur || {}), ...patch, updated_at: new Date().toISOString() };
  const rpm = (row?.role_payment_methods && typeof row.role_payment_methods === 'object' && !Array.isArray(row.role_payment_methods))
    ? { ...row.role_payment_methods }
    : {};
  rpm[KEY] = next;
  if (row?.id) await admin.from('app_settings').update({ role_payment_methods: rpm }).eq('id', row.id);
  else await admin.from('app_settings').insert({ created_by: userId, role_payment_methods: rpm });
  return next;
}

async function findStoreByChannel(phoneId, igId) {
  if (!admin) return null;
  const { data } = await admin.from('app_settings').select('id,created_by,role_payment_methods').limit(400);
  for (const r of data || []) {
    const a = r.role_payment_methods?.[KEY];
    if (!a) continue;
    if (phoneId && (a.wa_phone_id === phoneId || a.wa_number === phoneId)) {
      return { userId: r.created_by, cfg: a };
    }
    if (igId && (a.ig_id === igId || a.ig_account === igId)) {
      return { userId: r.created_by, cfg: a };
    }
  }
  return null;
}

async function storeContext(userId, cfg) {
  const bits = [];
  bits.push(`Você é ${cfg.agent_name || 'Atendente'} da loja. Personalidade: ${cfg.personality || 'amigável'}.`);
  bits.push('NUNCA invente preço, estoque, produto, desconto, prazo, taxa de entrega, forma de pagamento ou promoção.');
  bits.push('Se não estiver nestes dados, diga que vai confirmar com um atendente.');
  if (cfg.instructions) bits.push(`Instruções da loja: ${cfg.instructions}`);
  if (admin) {
    try {
      const { data: st } = await admin.from('app_settings').select('company_name,company_phone,company_address').eq('created_by', userId).limit(1);
      const s = (st || [])[0];
      if (s) bits.push(`LOJA: ${s.company_name || ''} Telefone: ${s.company_phone || ''} Endereço: ${s.company_address || ''}`);
    } catch { /* ignore */ }
    if (cfg.allow_price !== false || cfg.allow_stock !== false) {
      try {
        const { data: products } = await admin.from('product').select('name,sale_price,stock,brand,category,description').eq('created_by', userId).limit(80);
        const lines = (products || []).map((p) => {
          const price = cfg.allow_price === false ? '' : ` — R$ ${Number(p.sale_price || 0).toFixed(2)}`;
          const stk = cfg.allow_stock === false ? '' : (Number(p.stock) > 0 ? ' — estoque disponível' : ' — sem estoque');
          return `${p.name}${p.brand ? ' (' + p.brand + ')' : ''}${price}${stk}`;
        });
        if (lines.length) bits.push('PRODUTOS:\n' + lines.join('\n'));
      } catch { /* ignore */ }
    }
    if (cfg.allow_delivery !== false) {
      try {
        const { data: fees } = await admin.from('delivery_fee').select('neighborhood,name,price,value').eq('created_by', userId).limit(40);
        const fl = (fees || []).map((f) => `${f.neighborhood || f.name}: R$ ${Number(f.price ?? f.value ?? 0).toFixed(2)}`);
        if (fl.length) bits.push('ENTREGA:\n' + fl.join('\n'));
      } catch { /* ignore */ }
    }
  }
  bits.push('FORMAS DE PAGAMENTO: consulte apenas o que a loja tiver cadastrado no Darocha (Pix, cartão, dinheiro). Não invente link de pagamento.');
  bits.push('Se o cliente pedir para falar com uma pessoa, responda que vai transferir e encerre com [[TRANSFERIR_HUMANO]].');
  bits.push('Não finalize pedido sem o cliente confirmar. Se for montar pedido, pergunte e só então use [[PEDIDO:...]] depois da confirmação.');
  return bits.join('\n');
}

async function callOpenAI(key, model, system, messages) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || 'gpt-4o-mini',
      temperature: 0.3,
      max_tokens: 400,
      messages: [{ role: 'system', content: system }, ...messages],
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error?.message || 'Falha na OpenAI');
  return {
    text: json.choices?.[0]?.message?.content || '',
    tokens: json.usage?.total_tokens || 0,
    model: json.model || model,
  };
}

async function callGemini(key, model, system, messages) {
  const m = model || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${encodeURIComponent(key)}`;
  const contents = messages.map((x) => ({
    role: x.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: x.content }],
  }));
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents,
      generationConfig: { temperature: 0.3, maxOutputTokens: 400 },
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error?.message || 'Falha no Gemini');
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  return { text, tokens: json.usageMetadata?.totalTokenCount || 0, model: m };
}

async function runModel(cfg, system, history) {
  const key = decryptSecret(cfg.api_key_encrypted);
  if (!key) throw new Error('API da loja não configurada');
  if ((cfg.provider || 'openai') === 'gemini') return callGemini(key, cfg.model, system, history);
  return callOpenAI(key, cfg.model, system, history);
}

async function saveMessage(userId, payload) {
  if (!admin) return;
  try {
    await admin.from('ai_message').insert({ created_by: userId, ...payload });
    return;
  } catch { /* tabela pode não existir */ }
  try {
    await admin.from('operational_log').insert({
      type: LOG,
      level: 'info',
      description: JSON.stringify({ created_by: userId, ...payload }),
      operator_name: 'ai',
    });
  } catch (e) {
    console.warn('ai save message', e.message || e);
  }
}

async function listConversations(userId) {
  if (!admin) return [];
  try {
    const { data, error } = await admin.from('ai_conversation').select('*').eq('created_by', userId).order('last_at', { ascending: false }).limit(80);
    if (!error && data) return data;
  } catch { /* ignore */ }
  try {
    const { data } = await admin.from('operational_log').select('id,description,created_at').eq('type', LOG).order('created_at', { ascending: false }).limit(200);
    const map = new Map();
    for (const r of data || []) {
      try {
        const p = JSON.parse(r.description || '{}');
        if (p.created_by !== userId) continue;
        const k = `${p.channel}:${p.customer_id}`;
        if (!map.has(k)) map.set(k, { id: r.id, channel: p.channel, customer_id: p.customer_id, last_message: p.body, last_at: r.created_at, status: p.status || 'ai' });
      } catch { /* ignore */ }
    }
    return [...map.values()];
  } catch {
    return [];
  }
}

async function upsertConversation(userId, channel, customerId, last, status) {
  if (!admin) return;
  try {
    const { data: found } = await admin.from('ai_conversation').select('id,status').eq('created_by', userId).eq('channel', channel).eq('customer_id', customerId).maybeSingle();
    if (found?.id) {
      await admin.from('ai_conversation').update({ last_message: last, last_at: new Date().toISOString(), status: status || found.status }).eq('id', found.id);
      return found;
    }
    const { data } = await admin.from('ai_conversation').insert({
      created_by: userId, channel, customer_id: customerId, last_message: last, status: status || 'ai',
    }).select().maybeSingle();
    return data;
  } catch { /* ignore */ }
  return { status: status || 'ai' };
}

async function sendMeta(cfg, channel, to, text) {
  const token = decryptSecret(channel === 'instagram' ? cfg.ig_token_encrypted : cfg.wa_token_encrypted);
  const phoneId = channel === 'instagram' ? cfg.ig_id : cfg.wa_phone_id;
  if (!token || !phoneId) throw new Error('Canal não conectado');
  const url = `https://graph.facebook.com/v21.0/${phoneId}/messages`;
  const body = channel === 'instagram'
    ? { recipient: { id: to }, message: { text } }
    : { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } };
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message || 'Falha ao enviar na Meta');
  return json;
}

ai.post('/ai-settings', async (c) => {
  const user = await requireUser(c);
  if (!user?.id) return c.json({ error: 'unauthorized' }, 401);
  const { ai: cfg } = await loadRow(user.id);
  return c.json({ ok: true, settings: publicCfg(cfg) });
});

ai.post('/ai-settings-save', async (c) => {
  const user = await requireUser(c);
  if (!user?.id) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const patch = {
    enabled: body.enabled === true,
    auto_reply: body.auto_reply !== false,
    provider: body.provider === 'gemini' ? 'gemini' : 'openai',
    model: String(body.model || '').slice(0, 80),
    agent_name: String(body.agent_name || 'Atendente').slice(0, 40),
    personality: String(body.personality || 'amigavel').slice(0, 40),
    instructions: String(body.instructions || '').slice(0, 2000),
    allow_stock: body.allow_stock !== false,
    allow_price: body.allow_price !== false,
    allow_delivery: body.allow_delivery !== false,
    allow_order: body.allow_order === true,
    transfer_human: body.transfer_human !== false,
  };
  if (body.api_key) {
    patch.api_key_encrypted = encryptSecret(String(body.api_key).trim());
    patch.key_hint = maskKey(body.api_key);
  }
  if (body.clear_key) {
    patch.api_key_encrypted = null;
    patch.key_hint = '';
    patch.enabled = false;
  }
  const saved = await saveAi(user.id, patch);
  console.info('ai settings saved', { user: user.id, provider: saved.provider, enabled: saved.enabled });
  return c.json({ ok: true, settings: publicCfg(saved) });
});

ai.post('/ai-test', async (c) => {
  const user = await requireUser(c);
  if (!user?.id) return c.json({ error: 'unauthorized' }, 401);
  const { ai: cfg } = await loadRow(user.id);
  if (!cfg?.api_key_encrypted) return c.json({ ok: false, message: 'Salve a chave de API da loja primeiro.' }, 400);
  try {
    const out = await runModel(cfg, 'Responda só: ok', [{ role: 'user', content: 'ping' }]);
    return c.json({ ok: true, message: 'Conexão funcionando', model: out.model });
  } catch (e) {
    return c.json({ ok: false, message: 'Não foi possível conectar. Confira a chave e o faturamento no provedor.' }, 400);
  }
});

ai.post('/ai-channel-save', async (c) => {
  const user = await requireUser(c);
  if (!user?.id) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const patch = {};
  if (body.channel === 'whatsapp') {
    if (body.disconnect) {
      patch.wa_connected = false; patch.wa_token_encrypted = null; patch.wa_phone_id = ''; patch.wa_number = '';
    } else {
      if (body.token) patch.wa_token_encrypted = encryptSecret(String(body.token));
      if (body.phone_id) patch.wa_phone_id = String(body.phone_id);
      if (body.number) patch.wa_number = String(body.number);
      patch.wa_connected = true;
    }
  }
  if (body.channel === 'instagram') {
    if (body.disconnect) {
      patch.ig_connected = false; patch.ig_token_encrypted = null; patch.ig_id = ''; patch.ig_account = '';
    } else {
      if (body.token) patch.ig_token_encrypted = encryptSecret(String(body.token));
      if (body.ig_id) patch.ig_id = String(body.ig_id);
      if (body.account) patch.ig_account = String(body.account);
      patch.ig_connected = true;
    }
  }
  const saved = await saveAi(user.id, patch);
  return c.json({ ok: true, settings: publicCfg(saved) });
});

ai.post('/ai-conversations', async (c) => {
  const user = await requireUser(c);
  if (!user?.id) return c.json({ error: 'unauthorized' }, 401);
  const rows = await listConversations(user.id);
  return c.json({ ok: true, conversations: rows });
});

ai.post('/ai-takeover', async (c) => {
  const user = await requireUser(c);
  if (!user?.id) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const status = body.human ? 'human' : 'ai';
  if (admin) {
    try {
      if (body.id) await admin.from('ai_conversation').update({ status }).eq('id', body.id).eq('created_by', user.id);
    } catch { /* ignore */ }
  }
  return c.json({ ok: true, status });
});

ai.post('/ai-test-send', async (c) => {
  const user = await requireUser(c);
  if (!user?.id) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const { ai: cfg } = await loadRow(user.id);
  try {
    await sendMeta(cfg || {}, body.channel || 'whatsapp', body.to, body.text || 'Teste Darocha PDV');
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ ok: false, message: e.message }, 400);
  }
});

ai.get('/ai-webhook', async (c) => {
  const mode = c.req.query('hub.mode');
  const token = c.req.query('hub.verify_token');
  const challenge = c.req.query('hub.challenge');
  const expected = process.env.META_VERIFY_TOKEN || process.env.AI_WEBHOOK_VERIFY_TOKEN || 'darocha-ai';
  if (mode === 'subscribe' && token === expected) return c.text(String(challenge || ''));
  return c.json({ error: 'forbidden' }, 403);
});

ai.post('/ai-webhook', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const entries = body.entry || [];
  for (const entry of entries) {
    const changes = entry.changes || [];
    for (const ch of changes) {
      const value = ch.value || {};
      const phoneId = value.metadata?.phone_number_id;
      const msgs = value.messages || [];
      for (const msg of msgs) {
        if (msg.type && msg.type !== 'text') continue;
        const text = msg.text?.body || '';
        const from = msg.from;
        const store = await findStoreByChannel(phoneId, null);
        if (!store) continue;
        await handleIncoming(store.userId, store.cfg, 'whatsapp', from, text);
      }
    }
    const messaging = entry.messaging || [];
    for (const ev of messaging) {
      const text = ev.message?.text;
      const sender = ev.sender?.id;
      const pageId = ev.recipient?.id || entry.id;
      if (!text || !sender) continue;
      const igFromChange = (entry.changes || []).map((x) => x.value?.metadata?.phone_number_id || x.value?.sender?.id).find(Boolean);
      const store = await findStoreByChannel(null, pageId || igFromChange);
      if (!store) continue;
      await handleIncoming(store.userId, store.cfg, 'instagram', sender, typeof text === 'string' ? text : text?.body || '');
    }
  }
  return c.json({ ok: true });
});

async function loadHistory(userId, channel, customerId) {
  if (!admin) return [];
  try {
    const { data } = await admin
      .from('ai_message')
      .select('role,body')
      .eq('created_by', userId)
      .eq('channel', channel)
      .eq('customer_id', customerId)
      .order('created_at', { ascending: false })
      .limit(12);
    return (data || []).reverse().map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.body || '').slice(0, 800),
    }));
  } catch {
    return [];
  }
}

async function handleIncoming(userId, cfg, channel, customerId, text) {
  const conv = await upsertConversation(userId, channel, customerId, text);
  await saveMessage(userId, { channel, customer_id: customerId, role: 'user', body: text });
  if (!cfg?.enabled || cfg.auto_reply === false || conv?.status === 'human') return;
  if (/falar com (uma )?pessoa|atendente humano|quero um humano/i.test(text) && cfg.transfer_human !== false) {
    await upsertConversation(userId, channel, customerId, text, 'human');
    const bye = 'Vou transferir você para um atendente da loja.';
    try { await sendMeta(cfg, channel, customerId, bye); } catch (e) { console.warn('ai send', e.message); }
    await saveMessage(userId, { channel, customer_id: customerId, role: 'assistant', body: bye, provider: cfg.provider });
    return;
  }
  try {
    const system = await storeContext(userId, cfg);
    const history = await loadHistory(userId, channel, customerId);
    history.push({ role: 'user', content: String(text).slice(0, 1000) });
    const out = await runModel(cfg, system, history);
    let reply = (out.text || '').trim();
    if (reply.includes('[[TRANSFERIR_HUMANO]]')) {
      await upsertConversation(userId, channel, customerId, reply, 'human');
      reply = reply.replace('[[TRANSFERIR_HUMANO]]', '').trim() || 'Vou transferir você para um atendente.';
    }
    if (!reply) reply = 'No momento não consegui responder automaticamente. Vou encaminhar seu atendimento para nossa equipe.';
    try { await sendMeta(cfg, channel, customerId, reply.slice(0, 1500)); } catch (e) { console.warn('ai send', e.message); }
    await saveMessage(userId, { channel, customer_id: customerId, role: 'assistant', body: reply, provider: cfg.provider, model: out.model, tokens: out.tokens });
  } catch (e) {
    console.warn('ai reply', e.message);
    try {
      await sendMeta(cfg, channel, customerId, 'No momento não consegui responder automaticamente. Vou encaminhar seu atendimento para nossa equipe.');
    } catch { /* ignore */ }
    await upsertConversation(userId, channel, customerId, text, 'human');
  }
}

ai.post('/ai-preview', async (c) => {
  const user = await requireUser(c);
  if (!user?.id) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const { ai: cfg } = await loadRow(user.id);
  if (!cfg?.api_key_encrypted) return c.json({ ok: false, message: 'Salve a chave da API da loja.' }, 400);
  try {
    const system = await storeContext(user.id, cfg);
    const out = await runModel(cfg, system, [{ role: 'user', content: String(body.text || 'Olá').slice(0, 1000) }]);
    return c.json({ ok: true, reply: out.text, model: out.model });
  } catch (e) {
    return c.json({ ok: false, message: 'Não foi possível gerar resposta. Confira a chave e o crédito no provedor.' }, 400);
  }
});

ai.post('/ai-meta-info', async (c) => {
  const user = await requireUser(c);
  if (!user?.id) return c.json({ error: 'unauthorized' }, 401);
  return c.json({
    ok: true,
    webhook: 'https://darocha-pdv-backend.onrender.com/functions/ai-webhook',
    verify_token: process.env.META_VERIFY_TOKEN || 'darocha-ai',
    app_configured: !!(process.env.META_APP_ID && process.env.META_APP_SECRET),
  });
});

export default ai;
