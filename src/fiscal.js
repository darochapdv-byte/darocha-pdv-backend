import { Hono } from 'hono';
import crypto from 'crypto';
import { admin } from './db.js';
import { requireUser, loadMergedAppSettingsRpm, mergeRolePaymentMethods } from './helpers.js';
import {
  encryptSecret,
  decryptSecret,
  onlyDigits,
  mapPaymentCode,
  saleTotalsMatch,
  explainSefaz,
} from './fiscal_helpers.js';

const fiscal = new Hono();
const PROVIDER = 'nuvemfiscal';
const API_BASE = (process.env.FISCAL_API_URL || 'https://api.nuvemfiscal.com.br').replace(/\/$/, '');
const DOC_TYPE = 'fiscal_document';
const SETTINGS_KEY = '__darocha_fiscal';

function env(k) {
  return process.env[k] || '';
}

function publicSettings(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    status: raw.status || 'incomplete',
    enabled: raw.enabled === true,
    environment: raw.environment || 'homologacao',
    cnpj: raw.cnpj ? onlyDigits(raw.cnpj) : '',
    legal_name: raw.legal_name || '',
    trade_name: raw.trade_name || '',
    ie: raw.ie || '',
    im: raw.im || '',
    phone: raw.phone || '',
    tax_regime: raw.tax_regime || '',
    address: raw.address || {},
    nfce: { series: raw.nfce_series || '1', next_number: raw.nfce_next || null },
    nfe: { series: raw.nfe_series || '1', next_number: raw.nfe_next || null },
    certificate: {
      uploaded: !!raw.certificate_uploaded,
      valid_until: raw.certificate_valid_until || null,
      expiring: raw.certificate_valid_until
        ? (new Date(raw.certificate_valid_until).getTime() - Date.now()) < 1000 * 60 * 60 * 24 * 30
        : false,
    },
    provider: PROVIDER,
    provider_company_id: raw.provider_company_id || null,
    connected: raw.enabled === true && !!(raw.provider_company_id && raw.certificate_uploaded),
    has_csc: !!raw.csc_encrypted,
  };
}

async function loadSettingsRow(userId) {
  if (!admin || !userId) return { row: null, fiscal: null };
  const { row, rpm } = await loadMergedAppSettingsRpm(userId);
  if (row) {
    const { data } = await admin
      .from('app_settings')
      .select('id,created_by,company_name,company_cnpj,company_address,company_phone,role_payment_methods')
      .eq('id', row.id)
      .maybeSingle();
    return { row: data || row, fiscal: rpm[SETTINGS_KEY] || null };
  }
  return { row: null, fiscal: rpm[SETTINGS_KEY] || null };
}

async function saveSettings(userId, patch) {
  const { row, fiscal } = await loadSettingsRow(userId);
  const { rpm } = await loadMergedAppSettingsRpm(userId);
  const next = { ...(fiscal || {}), ...patch, updated_at: new Date().toISOString() };
  const merged = mergeRolePaymentMethods(rpm, { [SETTINGS_KEY]: next });
  if (row?.id) {
    await admin.from('app_settings').update({ role_payment_methods: merged }).eq('id', row.id);
  } else {
    await admin.from('app_settings').insert({ created_by: userId, role_payment_methods: merged });
  }
  return next;
}

async function providerFetch(path, { method = 'GET', body, headers = {}, form } = {}) {
  const token = env('FISCAL_API_TOKEN') || env('NUVEM_FISCAL_TOKEN');
  if (!token) {
    const err = new Error('Provedor fiscal não configurado no servidor (FISCAL_API_TOKEN).');
    err.code = 'provider_not_configured';
    throw err;
  }
  const h = { Authorization: `Bearer ${token}`, ...headers };
  let payload;
  if (form) {
    payload = { method, headers: h, body: form };
  } else {
    h['Content-Type'] = 'application/json';
    payload = { method, headers: h, body: body != null ? JSON.stringify(body) : undefined };
  }
  const res = await fetch(`${API_BASE}${path}`, payload);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(json?.error?.mensagem || json?.message || json?.erro || `HTTP ${res.status}`);
    err.status = res.status;
    err.payload = json;
    err.code = 'provider_error';
    throw err;
  }
  return json;
}

function missingCompany(cfg, company) {
  const miss = [];
  const cnpj = onlyDigits(cfg?.cnpj || company?.company_cnpj);
  if (cnpj.length !== 14) miss.push('CNPJ da empresa');
  if (!(cfg?.legal_name || company?.company_name)) miss.push('Razão social');
  if (!(cfg?.ie || company?.company_ie)) miss.push('Inscrição estadual');
  if (!(cfg?.address?.city || cfg?.address?.municipio)) miss.push('Município');
  if (!(cfg?.address?.uf)) miss.push('UF');
  if (!onlyDigits(cfg?.address?.cep || '').length) miss.push('CEP');
  if (!cfg?.certificate_uploaded) miss.push('Certificado A1');
  if (!cfg?.provider_company_id && !(env('FISCAL_API_TOKEN') || env('NUVEM_FISCAL_TOKEN'))) {
    miss.push('Token do provedor fiscal no servidor');
  }
  return miss;
}

function missingProducts(items) {
  const out = [];
  for (const it of items || []) {
    const name = it.name || it.product_name || 'item';
    if (!String(it.ncm || it.NCM || '').replace(/\D/g, '')) out.push(`Não é possível emitir a NFC-e porque o produto "${name}" está sem NCM.`);
  }
  return out;
}

async function insertDocument(doc) {
  if (admin) {
    try {
      const { data, error } = await admin.from('fiscal_document').insert(doc).select().maybeSingle();
      if (!error && data) return { ...data, _store: 'table' };
    } catch { /* tabela pode não existir */ }
    try {
      const { data } = await admin.from('operational_log').insert({
        type: DOC_TYPE,
        level: 'info',
        description: JSON.stringify(doc),
        operator_name: doc.created_by,
      }).select().maybeSingle();
      return { ...doc, id: data?.id || doc.id, _store: 'log' };
    } catch (e) {
      console.warn('fiscal insert fallback', e.message || e);
    }
  }
  return { ...doc, _store: 'memory' };
}

async function updateDocument(userId, id, patch) {
  if (admin) {
    try {
      const { data, error } = await admin.from('fiscal_document').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).eq('created_by', userId).select().maybeSingle();
      if (!error && data) return data;
    } catch { /* ignore */ }
    try {
      const { data: row } = await admin.from('operational_log').select('id,description').eq('id', id).maybeSingle();
      if (row) {
        const cur = JSON.parse(row.description || '{}');
        if (cur.created_by && cur.created_by !== userId) return null;
        const next = { ...cur, ...patch, updated_at: new Date().toISOString() };
        await admin.from('operational_log').update({ description: JSON.stringify(next) }).eq('id', id);
        return next;
      }
    } catch { /* ignore */ }
  }
  return null;
}

async function listDocuments(userId, filters = {}) {
  if (admin) {
    try {
      let q = admin.from('fiscal_document').select('*').eq('created_by', userId).order('created_at', { ascending: false }).limit(200);
      if (filters.status) q = q.eq('status', filters.status);
      if (filters.sale_id) q = q.eq('sale_id', filters.sale_id);
      const { data, error } = await q;
      if (!error && Array.isArray(data)) return data;
    } catch { /* ignore */ }
    try {
      const { data } = await admin.from('operational_log').select('id,description,created_at').eq('type', DOC_TYPE).order('created_at', { ascending: false }).limit(400);
      return (data || []).map((r) => {
        try { return { id: r.id, created_at: r.created_at, ...JSON.parse(r.description || '{}') }; } catch { return null; }
      }).filter((d) => d && d.created_by === userId);
    } catch { /* ignore */ }
  }
  return [];
}

async function getDocument(userId, id) {
  const all = await listDocuments(userId);
  return all.find((d) => String(d.id) === String(id)) || null;
}

function rateKey(userId, route) {
  return `${userId}:${route}`;
}
const buckets = new Map();
function rateLimit(userId, route, max = 20, windowMs = 60000) {
  const k = rateKey(userId, route);
  const now = Date.now();
  const cur = buckets.get(k) || [];
  const keep = cur.filter((t) => now - t < windowMs);
  if (keep.length >= max) return false;
  keep.push(now);
  buckets.set(k, keep);
  return true;
}

function canManageFiscal(user) {
  if (!user?.id) return false;
  const role = String(user?.role || user?.data?.role || '').toLowerCase().trim();
  const blocked = new Set(['caixa', 'operador', 'vendedor', 'entregador', 'courier', 'employee', 'funcionario']);
  if (blocked.has(role)) return false;
  return true;
}

fiscal.post('/fiscal-disconnect', async (c) => {
  const user = await requireUser(c);
  if (!user?.id) return c.json({ error: 'unauthorized' }, 401);
  if (!canManageFiscal(user)) return c.json({ error: 'forbidden', message: 'Seu usuário não pode alterar o Fiscal.' }, 403);
  const saved = await saveSettings(user.id, { enabled: false, status: 'disabled' });
  return c.json({ ok: true, settings: publicSettings(saved) });
});

fiscal.post('/fiscal-connect-toggle', async (c) => {
  const user = await requireUser(c);
  if (!user?.id) return c.json({ error: 'unauthorized' }, 401);
  if (!canManageFiscal(user)) return c.json({ error: 'forbidden', message: 'Seu usuário não pode alterar o Fiscal.' }, 403);
  const body = await c.req.json().catch(() => ({}));
  const saved = await saveSettings(user.id, { enabled: body.enabled === true, status: body.enabled ? 'configured' : 'disabled' });
  return c.json({ ok: true, settings: publicSettings(saved) });
});

fiscal.post('/fiscal-settings', async (c) => {
  const user = await requireUser(c);
  if (!user?.id) return c.json({ error: 'unauthorized' }, 401);
  const { fiscal: cfg, row } = await loadSettingsRow(user.id);
  return c.json({
    ok: true,
    settings: publicSettings(cfg),
    company_defaults: {
      company_name: row?.company_name || user.company_name || '',
      company_cnpj: row?.company_cnpj || user.company_cnpj || '',
      company_address: row?.company_address || user.company_address || '',
      company_phone: row?.company_phone || user.company_phone || '',
    },
  });
});

fiscal.post('/fiscal-settings-save', async (c) => {
  const user = await requireUser(c);
  if (!user?.id) return c.json({ error: 'unauthorized' }, 401);
  if (!canManageFiscal(user)) return c.json({ error: 'forbidden', message: 'Só o administrador da loja altera a configuração fiscal.' }, 403);
  if (!rateLimit(user.id, 'save', 30)) return c.json({ error: 'rate_limited' }, 429);
  const body = await c.req.json().catch(() => ({}));
  const { fiscal: prevFiscal } = await loadSettingsRow(user.id);
  if (body.product_codes && typeof body.product_codes === 'object') {
    const mergedCodes = { ...(prevFiscal?.product_codes || {}), ...body.product_codes };
    if (body.only_codes) {
      const saved = await saveSettings(user.id, { product_codes: mergedCodes });
      return c.json({ ok: true, settings: publicSettings(saved) });
    }
    body._merged_codes = mergedCodes;
  }
  const patch = {
    status: 'configured',
    environment: body.environment === 'producao' ? 'producao' : 'homologacao',
    cnpj: onlyDigits(body.cnpj),
    legal_name: String(body.legal_name || '').slice(0, 120),
    trade_name: String(body.trade_name || '').slice(0, 120),
    ie: String(body.ie || '').slice(0, 20),
    im: String(body.im || '').slice(0, 20),
    phone: String(body.phone || '').slice(0, 20),
    tax_regime: String(body.tax_regime || '').slice(0, 40),
    address: body.address && typeof body.address === 'object' ? body.address : {},
    nfce_series: String(body.nfce_series || '1').slice(0, 5),
    nfe_series: String(body.nfe_series || '1').slice(0, 5),
  };
  if (body._merged_codes) patch.product_codes = body._merged_codes;
  if (body.csc) patch.csc_encrypted = encryptSecret(String(body.csc));
  if (body.id_token) patch.id_token_encrypted = encryptSecret(String(body.id_token));
  const saved = await saveSettings(user.id, patch);
  console.info('fiscal settings saved', { user: user.id, env: patch.environment, cnpj: patch.cnpj });
  return c.json({ ok: true, settings: publicSettings(saved) });
});

fiscal.post('/fiscal-certificate', async (c) => {
  const user = await requireUser(c);
  if (!user?.id) return c.json({ error: 'unauthorized' }, 401);
  if (!canManageFiscal(user)) return c.json({ error: 'forbidden' }, 403);
  const form = await c.req.parseBody();
  const file = form.file || form.certificate || form.certificado;
  const password = String(form.password || form.senha || '');
  if (!file || typeof file === 'string') return c.json({ error: 'file_required', message: 'Envie o certificado A1 (.pfx/.p12).' }, 400);
  if (!password) return c.json({ error: 'password_required', message: 'Informe a senha do certificado.' }, 400);
  const { fiscal: cfg } = await loadSettingsRow(user.id);
  if (!cfg?.cnpj) return c.json({ error: 'config', message: 'Salve o CNPJ antes de enviar o certificado.' }, 400);
  try {
    let companyId = cfg.provider_company_id;
    if (!companyId) {
      const created = await providerFetch('/empresas', {
        method: 'POST',
        body: {
          cpf_cnpj: onlyDigits(cfg.cnpj),
          inscricao_estadual: cfg.ie || null,
          nome_razao_social: cfg.legal_name,
          nome_fantasia: cfg.trade_name || cfg.legal_name,
          email: user.email || undefined,
        },
      });
      companyId = created?.id || created?.empresa_id || created?.data?.id;
    }
    const buf = Buffer.from(await file.arrayBuffer());
    const fd = new FormData();
    fd.append('certificado', new Blob([buf]), file.name || 'certificado.pfx');
    fd.append('password', password);
    const certRes = await providerFetch(`/empresas/${companyId}/certificado`, { method: 'PUT', form: fd });
    const validUntil = certRes?.data_validade || certRes?.validade || certRes?.not_after || null;
    const saved = await saveSettings(user.id, {
      provider_company_id: companyId,
      certificate_uploaded: true,
      certificate_valid_until: validUntil,
    });
    console.info('fiscal certificate uploaded', { user: user.id, companyId, validUntil });
    return c.json({ ok: true, settings: publicSettings(saved) });
  } catch (e) {
    return c.json({
      ok: false,
      kind: e.code === 'provider_not_configured' ? 'config' : 'comunicacao',
      message: e.message,
    }, e.code === 'provider_not_configured' ? 503 : 400);
  }
});

fiscal.post('/fiscal-test', async (c) => {
  const user = await requireUser(c);
  if (!user?.id) return c.json({ error: 'unauthorized' }, 401);
  const { fiscal: cfg, row } = await loadSettingsRow(user.id);
  if (!cfg || cfg.enabled !== true) return c.json({ ok: false, kind: 'config', message: 'Emissão fiscal desconectada. Ligue em Configurações → Sistema → Fiscal.' }, 400);
  const miss = missingCompany(cfg, { ...user, ...row });
  if (miss.length) {
    return c.json({ ok: false, kind: 'config', message: 'Configuração incompleta.', missing: miss });
  }
  try {
    if (cfg.provider_company_id) {
      await providerFetch(`/empresas/${cfg.provider_company_id}`);
    }
    return c.json({
      ok: true,
      environment: cfg.environment || 'homologacao',
      message: (cfg.environment === 'producao')
        ? 'Configuração válida para produção.'
        : 'Ambiente de homologação — documento sem validade fiscal.',
    });
  } catch (e) {
    return c.json({ ok: false, kind: e.code === 'provider_not_configured' ? 'config' : 'comunicacao', message: e.message }, 400);
  }
});

fiscal.post('/fiscal-nfce', async (c) => {
  const user = await requireUser(c);
  if (!user?.id) return c.json({ error: 'unauthorized' }, 401);
  if (!rateLimit(user.id, 'emit', 12)) return c.json({ error: 'rate_limited', message: 'Muitas tentativas. Aguarde um minuto.' }, 429);
  const body = await c.req.json().catch(() => ({}));
  const saleId = String(body.sale_id || body.sale?.id || '');
  const sale = body.sale || {};
  if (!saleId) return c.json({ error: 'sale_required', message: 'Informe a venda.' }, 400);

  const existing = await listDocuments(user.id, { sale_id: saleId });
  const authorized = existing.find((d) => d.status === 'autorizada' && d.document_type === 'nfce');
  if (authorized) {
    return c.json({ ok: true, already: true, document: sanitizeDoc(authorized) });
  }
  const processing = existing.find((d) => ['processando', 'aguardando'].includes(d.status));
  if (processing) {
    return c.json({ ok: true, already: true, document: sanitizeDoc(processing) });
  }

  const { fiscal: cfg, row } = await loadSettingsRow(user.id);
  const miss = missingCompany(cfg, { ...user, ...row });
  if (miss.length) return c.json({ ok: false, kind: 'config', message: 'Configuração fiscal incompleta.', missing: miss }, 400);

  const rawItems = Array.isArray(sale.items) ? sale.items : (body.items || []);
  const codes = (cfg && cfg.product_codes) || {};
  const items = rawItems.map((it) => {
    const id = String(it.product_id || it.id || it.sku || it.barcode || '');
    const extra = codes[id] || codes[String(it.barcode || '')] || {};
    return {
      ...it,
      ncm: it.ncm || it.NCM || extra.ncm || '',
      cfop: it.cfop || it.CFOP || extra.cfop || '5102',
    };
  });
  const prodMiss = missingProducts(items);
  if (prodMiss.length) return c.json({ ok: false, kind: 'config', message: prodMiss[0], missing: prodMiss }, 400);

  const totals = saleTotalsMatch({ ...sale, items, total: sale.total ?? body.total });
  if (!totals.ok) {
    return c.json({
      ok: false,
      kind: 'config',
      message: `Total da nota (${totals.computed.toFixed(2)}) diferente da venda (${totals.total.toFixed(2)}).`,
    }, 400);
  }

  const payments = Array.isArray(sale.payments) ? sale.payments : (body.payments || []);
  const mappedPay = payments.length
    ? payments.map((p) => ({ ...mapPaymentCode(p.method || p.type || p.forma), vPag: Number(p.amount || p.value || totals.total) }))
    : [{ ...mapPaymentCode(sale.payment_method || sale.payment || 'outros'), vPag: totals.total }];

  const idem = `nfce:${user.id}:${saleId}`;
  const draft = {
    id: crypto.randomUUID(),
    created_by: user.id,
    sale_id: saleId,
    document_type: 'nfce',
    model: '65',
    status: 'processando',
    environment: cfg.environment || 'homologacao',
    provider: PROVIDER,
    idempotency_key: idem,
    total: totals.total,
    customer_doc: onlyDigits(body.customer?.cpf || body.customer?.cnpj || sale.customer_doc || ''),
    customer_name: body.customer?.name || sale.customer_name || '',
    payment_summary: mappedPay,
    created_at: new Date().toISOString(),
  };
  const saved = await insertDocument(draft);

  try {
    const payload = buildNfcePayload(cfg, sale, items, mappedPay, draft, user);
    const created = await providerFetch('/nfce', { method: 'POST', body: payload });
    const status = mapProviderStatus(created?.status || created?.situacao);
    const explained = status === 'rejeitada' ? explainSefaz(created?.codigo_status || created?.codigo, created?.motivo_status || created?.motivo) : null;
    const updated = await updateDocument(user.id, saved.id, {
      status,
      provider_document_id: created?.id || created?.uuid,
      provider_status: created?.status || created?.situacao,
      access_key: created?.chave || created?.chave_acesso,
      protocol: created?.protocolo,
      number: created?.numero,
      series: created?.serie || cfg.nfce_series,
      rejection_code: explained?.code,
      rejection_message: explained?.text,
      rejection_hint: explained ? `${explained.cause} ${explained.action}` : null,
      authorization_date: status === 'autorizada' ? new Date().toISOString() : null,
      xml: created?.xml || null,
      danfe_url: created?.danfe || created?.links?.danfe || null,
      qrcode_url: created?.qrcode || created?.links?.qrcode || null,
    });
    console.info('fiscal nfce result', { user: user.id, saleId, status, id: saved.id });
    return c.json({ ok: status === 'autorizada' || status === 'processando', document: sanitizeDoc(updated || { ...draft, status }), homolog: draft.environment !== 'producao' });
  } catch (e) {
    const explained = explainSefaz(e.payload?.codigo_status, e.message);
    await updateDocument(user.id, saved.id, {
      status: e.code === 'provider_not_configured' ? 'erro' : 'rejeitada',
      rejection_code: explained.code,
      rejection_message: explained.text,
      rejection_hint: `${explained.cause} ${explained.action}`,
    });
    return c.json({
      ok: false,
      kind: e.code === 'provider_not_configured' ? 'config' : (e.code === 'provider_error' ? 'sefaz' : 'comunicacao'),
      message: explained.text,
      cause: explained.cause,
      action: explained.action,
      document_id: saved.id,
    }, 400);
  }
});

fiscal.post('/fiscal-nfe', async (c) => {
  const user = await requireUser(c);
  if (!user?.id) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({}));
  return c.json({
    ok: false,
    kind: 'config',
    message: 'NF-e modelo 55 usa o mesmo módulo. Configure a NFC-e primeiro; a NF-e reutiliza empresa, certificado e produtos.',
    hint: 'Chame /functions/fiscal-nfce para consumidor final. NF-e completa exige destinatário com IE quando aplicável.',
    received_sale: !!(body.sale_id || body.sale),
  }, 501);
});

fiscal.post('/fiscal-documents', async (c) => {
  const user = await requireUser(c);
  if (!user?.id) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const rows = await listDocuments(user.id, body);
  return c.json({ ok: true, documents: rows.map(sanitizeDoc) });
});

fiscal.post('/fiscal-document', async (c) => {
  const user = await requireUser(c);
  if (!user?.id) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const doc = await getDocument(user.id, body.id);
  if (!doc) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true, document: sanitizeDoc(doc) });
});

fiscal.post('/fiscal-document-xml', async (c) => {
  const user = await requireUser(c);
  if (!user?.id) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const doc = await getDocument(user.id, body.id);
  if (!doc) return c.json({ error: 'not_found' }, 404);
  if (!doc.xml && doc.provider_document_id) {
    try {
      const xml = await providerFetch(`/nfce/${doc.provider_document_id}/xml`);
      return c.json({ ok: true, xml: xml?.xml || xml });
    } catch (e) {
      return c.json({ ok: false, message: e.message }, 400);
    }
  }
  return c.json({ ok: true, xml: doc.xml || null });
});

fiscal.post('/fiscal-document-danfe', async (c) => {
  const user = await requireUser(c);
  if (!user?.id) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const doc = await getDocument(user.id, body.id);
  if (!doc) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true, url: doc.danfe_url || null, qrcode_url: doc.qrcode_url || null, access_key: doc.access_key || null });
});

fiscal.post('/fiscal-cancel', async (c) => {
  const user = await requireUser(c);
  if (!user?.id) return c.json({ error: 'unauthorized' }, 401);
  if (!canManageFiscal(user)) return c.json({ error: 'forbidden', message: 'Só o administrador cancela documento fiscal.' }, 403);
  const body = await c.req.json().catch(() => ({}));
  const reason = String(body.reason || body.justificativa || '').trim();
  if (reason.length < 15) return c.json({ error: 'reason', message: 'Informe o motivo do cancelamento (mínimo 15 caracteres).' }, 400);
  const doc = await getDocument(user.id, body.id);
  if (!doc) return c.json({ error: 'not_found' }, 404);
  if (doc.status === 'cancelada') return c.json({ ok: true, document: sanitizeDoc(doc) });
  if (doc.status !== 'autorizada') return c.json({ error: 'invalid_status', message: 'Só é possível cancelar documento autorizado.' }, 400);
  try {
    if (doc.provider_document_id) {
      await providerFetch(`/nfce/${doc.provider_document_id}/cancelamento`, { method: 'POST', body: { justificativa: reason } });
    }
    const updated = await updateDocument(user.id, doc.id, {
      status: 'cancelada',
      cancel_reason: reason,
      cancelled_by: user.id,
      cancellation_date: new Date().toISOString(),
    });
    console.info('fiscal cancel', { user: user.id, id: doc.id });
    return c.json({ ok: true, document: sanitizeDoc(updated || { ...doc, status: 'cancelada' }) });
  } catch (e) {
    return c.json({ ok: false, kind: 'sefaz', message: e.message }, 400);
  }
});

fiscal.post('/fiscal-status', async (c) => {
  const user = await requireUser(c);
  if (!user?.id) return c.json({ error: 'unauthorized' }, 401);
  const { fiscal: cfg } = await loadSettingsRow(user.id);
  return c.json({
    ok: true,
    provider: PROVIDER,
    configured: !!cfg,
    environment: cfg?.environment || 'homologacao',
    connected: !!(cfg?.provider_company_id && cfg?.certificate_uploaded),
    server_token: !!(env('FISCAL_API_TOKEN') || env('NUVEM_FISCAL_TOKEN')),
  });
});

fiscal.post('/fiscal-webhook', async (c) => {
  const secret = env('FISCAL_WEBHOOK_SECRET');
  const sig = c.req.header('X-NuvemFiscal-Signature') || c.req.header('X-Webhook-Signature') || '';
  if (secret && sig && sig !== secret) return c.json({ error: 'invalid_signature' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const providerId = body?.id || body?.data?.id || body?.documento?.id;
  const eventId = body?.evento_id || body?.event_id || providerId;
  if (!providerId) return c.json({ ok: true, ignored: true });
  if (admin) {
    try {
      const { data } = await admin.from('fiscal_document').select('*').eq('provider_document_id', String(providerId)).limit(1);
      const doc = (data || [])[0];
      if (doc) {
        const status = mapProviderStatus(body.status || body.situacao || body.data?.status);
        await admin.from('fiscal_document').update({
          status,
          provider_status: body.status || body.situacao,
          access_key: body.chave || doc.access_key,
          protocol: body.protocolo || doc.protocol,
          updated_at: new Date().toISOString(),
        }).eq('id', doc.id);
      }
    } catch { /* ignore */ }
  }
  console.info('fiscal webhook', { eventId, providerId });
  return c.json({ ok: true, eventId });
});

function mapProviderStatus(s) {
  const v = String(s || '').toLowerCase();
  if (v.includes('autoriz')) return 'autorizada';
  if (v.includes('cancel')) return 'cancelada';
  if (v.includes('rejeit') || v.includes('negad')) return 'rejeitada';
  if (v.includes('inutil')) return 'inutilizada';
  if (v.includes('conting')) return 'contingencia';
  if (v.includes('process') || v.includes('pend')) return 'processando';
  if (v.includes('erro')) return 'erro';
  return 'processando';
}

function sanitizeDoc(doc) {
  if (!doc) return null;
  const { xml, ...rest } = doc;
  return { ...rest, has_xml: !!xml };
}

function buildNfcePayload(cfg, sale, items, payments, draft, user) {
  const destDoc = draft.customer_doc;
  return {
    ambiente: cfg.environment === 'producao' ? 'producao' : 'homologacao',
    referencia: draft.idempotency_key,
    csc: cfg.csc_encrypted ? decryptSecret(cfg.csc_encrypted) : undefined,
    natureza_operacao: 'VENDA',
    serie: Number(cfg.nfce_series || 1),
    informacoes_adicionais_contribuinte: draft.environment !== 'producao' ? 'AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL' : undefined,
    destinatario: destDoc
      ? {
          cpf: destDoc.length === 11 ? destDoc : undefined,
          cnpj: destDoc.length === 14 ? destDoc : undefined,
          nome: draft.customer_name || undefined,
        }
      : undefined,
    itens: items.map((it, idx) => ({
      numero_item: idx + 1,
      codigo_produto: String(it.id || it.sku || idx + 1).slice(0, 20),
      descricao: String(it.name || it.product_name || 'Item').slice(0, 120),
      codigo_ncm: onlyDigits(it.ncm || it.NCM).slice(0, 8),
      cfop: onlyDigits(it.cfop || it.CFOP || '5102'),
      unidade_comercial: String(it.unit || it.unidade || 'UN').slice(0, 6),
      quantidade_comercial: Number(it.qty ?? it.quantity ?? 1),
      valor_unitario_comercial: Number(it.sale_price ?? it.unit_price ?? it.price ?? 0),
      valor_bruto: Number(it.qty ?? it.quantity ?? 1) * Number(it.sale_price ?? it.unit_price ?? it.price ?? 0),
      origem: String(it.origin ?? it.origem ?? '0'),
      incluir_no_total: true,
    })),
    pagamentos: payments.map((p) => ({
      tPag: p.tPag,
      descricao: p.label,
      valor: Number(p.vPag || 0),
    })),
  };
}

export default fiscal;
export const fiscalHelpers = { mapPaymentCode, saleTotalsMatch, explainSefaz, onlyDigits, encryptSecret, decryptSecret };
