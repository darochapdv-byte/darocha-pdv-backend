import { admin } from './db.js';

export function stackOf(error) {
  return (error && (error.stack || error.message)) || String(error || '');
}

export async function logOperation(entry) {
  if (!admin) return;
  try {
    await admin.from('operational_log').insert({
      type: entry.type || 'unexpected_error',
      level: entry.level || 'info',
      description: String(entry.description || '').slice(0, 2000),
      operator_name: entry.operator_name || '',
      device_id: entry.device_id || '',
      cash_session_id: entry.cash_session_id || '',
      sale_id: entry.sale_id || '',
      client_ref: entry.client_ref || '',
      stack_trace: String(entry.stack_trace || '').slice(0, 4000),
    });
  } catch (e) {
    console.error('logOperation failed', e);
  }
}

/** Libera reservas ativas de uma sessão de caixa */
export async function releaseSessionReservations(sessionId) {
  if (!sessionId || !admin) return 0;
  try {
    const { data: own } = await admin
      .from('stock_reservation')
      .select('id')
      .eq('holder_id', sessionId)
      .eq('status', 'ativa')
      .limit(2000);
    if (!own?.length) return 0;
    await admin
      .from('stock_reservation')
      .update({ status: 'liberada' })
      .in(
        'id',
        own.map((r) => r.id)
      );
    return own.length;
  } catch (e) {
    console.error('releaseSessionReservations error', e);
    return 0;
  }
}

/** Extrai usuário do request (JWT local ou Supabase) */
export async function requireUser(c) {
  const { getUserFromRequest } = await import('./auth.js');
  return getUserFromRequest(c);
}

/** Limpa reservas expiradas e retorna mapa product_id → qty reservada */
export async function buildReservationMap(excludeHolderId = null) {
  if (!admin) return {};
  try {
    const now = new Date().toISOString();
    const { data: active } = await admin
      .from('stock_reservation')
      .select('*')
      .eq('status', 'ativa')
      .limit(3000);
    const expired = (active || []).filter((r) => r.expires_at && r.expires_at < now);
    if (expired.length) {
      await admin
        .from('stock_reservation')
        .update({ status: 'liberada' })
        .in('id', expired.map((r) => r.id));
    }
    const map = {};
    for (const r of active || []) {
      if (r.expires_at && r.expires_at < now) continue;
      if (excludeHolderId && r.holder_id === excludeHolderId) continue;
      map[r.product_id] = (map[r.product_id] || 0) + (Number(r.quantity) || 0);
    }
    return map;
  } catch (e) {
    console.error('buildReservationMap', e);
    return {};
  }
}

export function computeCatalogAvailable(stock, reserve, reservedQty) {
  const s = Math.max(0, Number(stock) || 0);
  const res = Math.max(0, Number(reserve) || 0);
  const rq = Math.max(0, Number(reservedQty) || 0);
  return Math.max(0, s - res - rq);
}

export function sanitizeDateFields(data) {
  if (!data || typeof data !== 'object') return data;

  const sanitizedData = { ...data };
  for (const key in sanitizedData) {
    if (key.includes('date') || key.includes('at')) { // Heuristic for date fields
      if (sanitizedData[key] === '' || sanitizedData[key] === undefined) {
        sanitizedData[key] = null;
      }
    }
  }
  return sanitizedData;
}

/** Campos virtuais / aliases do frontend Base44 que não existem no Postgres */
const FIELD_ALIASES = {
  cost_price: 'cost',
  created_date: null, // virtual — não gravar
  updated_date: null,
  image: 'image_url',
  photo: 'image_url',
  photo_url: 'image_url',
};

/** Limpa body antes de insert/update: aliases + remove vazios problemáticos */
export function sanitizeEntityBody(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  let out = sanitizeDateFields({ ...data });

  for (const [from, to] of Object.entries(FIELD_ALIASES)) {
    if (!(from in out)) continue;
    if (to && (out[to] === undefined || out[to] === null || out[to] === '')) {
      out[to] = out[from];
    }
    delete out[from];
  }

  return out;
}

/**
 * Compatibilidade Base44: o frontend usa created_date / updated_date,
 * enquanto o Postgres/Supabase grava created_at / updated_at.
 */
export function toBase44Row(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const out = { ...row };
  if (out.created_at != null && out.created_date == null) out.created_date = out.created_at;
  if (out.updated_at != null && out.updated_date == null) out.updated_date = out.updated_at;
  return out;
}

export function toBase44Rows(rows) {
  if (rows == null) return rows;
  if (!Array.isArray(rows)) return toBase44Row(rows);
  return rows.map(toBase44Row);
}

const ZERO_STOCK_SETTING_TYPE = 'system_setting_allow_zero_stock';
const CATALOG_SLUG_TYPE = 'catalog_slug';

/** Subdomínios/slugs reservados (não podem ser usados por lojas). */
export const RESERVED_SLUGS = new Set([
  'www', 'app', 'api', 'admin', 'suporte', 'mail', 'ftp', 'dashboard', 'painel',
  'static', 'assets', 'cdn', 'login', 'register', 'catalogo', 'catalog', 'help',
  'status', 'billing', 'stripe', 'webhook', 'user', 'users', 'store', 'stores',
  'darocha', 'darochapdv', 'root', 'null', 'undefined', 'test', 'demo',
]);

/** Normaliza slug: minúsculo, a-z, 0-9 e hífen. */
export function normalizeSlug(slug) {
  if (!slug || typeof slug !== 'string') return '';
  return String(slug)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** Gera slug a partir do nome da loja (minúsculo, sem acento, hífens). */
export function slugifyStoreName(name) {
  if (!name || typeof name !== 'string') return '';
  return normalizeSlug(name);
}

export function isReservedSlug(slug) {
  const s = normalizeSlug(slug);
  return !s || RESERVED_SLUGS.has(s);
}

/**
 * URL pública da loja.
 * Preferência: https://{slug}.darochapdv.com
 * Fallback legado: /catalogo?loja=slug
 */
export function buildStorePublicUrl(slug, path = '') {
  const s = normalizeSlug(slug);
  const apex = String(process.env.APEX_DOMAIN || 'darochapdv.com').replace(/^www\./, '');
  const useSub = process.env.USE_SUBDOMAIN_URLS !== 'false';
  const legacyBase = String(process.env.FRONTEND_URL || 'https://dist-ten-mu-12.vercel.app').replace(/\/$/, '');
  if (!s) return legacyBase;
  const p = path ? (path.startsWith('/') ? path : `/${path}`) : '';
  if (useSub) {
    return `https://${s}.${apex}${p}`;
  }
  if (!p || p === '/' || p.startsWith('/catalogo')) {
    return `${legacyBase}/catalogo?loja=${encodeURIComponent(s)}`;
  }
  const sep = p.includes('?') ? '&' : '?';
  return `${legacyBase}${p}${sep}loja=${encodeURIComponent(s)}`;
}

/** Lista todos os slugs já registrados (operational_log). */
async function listCatalogSlugs() {
  if (!admin) return [];
  try {
    const { data } = await admin
      .from('operational_log')
      .select('description')
      .eq('type', CATALOG_SLUG_TYPE)
      .order('created_at', { ascending: false })
      .limit(2000);
    const out = [];
    for (const row of data || []) {
      try {
        const p = JSON.parse(row.description || '{}');
        if (p?.slug && p?.user_id) out.push({ slug: String(p.slug).toLowerCase(), user_id: p.user_id });
      } catch { /* ignore */ }
    }
    return out;
  } catch (e) {
    console.error('listCatalogSlugs', e.message || e);
    return [];
  }
}

/**
 * Gera um slug único baseado no nome da loja.
 * Se já existir, acrescenta sufixo numérico (ex: loja, loja2, loja3).
 * Proíbe dois usuários com o mesmo slug.
 */
export async function generateUniqueCatalogSlug(companyName, userId) {
  const base = slugifyStoreName(companyName) || `loja${String(userId || '').replace(/-/g, '').slice(0, 8)}`;
  const existing = await listCatalogSlugs();
  const taken = new Set(existing.filter((e) => e.user_id !== userId).map((e) => e.slug));

  // Se este usuário já tem um slug, reutiliza se ainda casar com o nome
  const mine = existing.find((e) => e.user_id === userId);
  if (mine && !taken.has(mine.slug) && (mine.slug === base || mine.slug.startsWith(base))) {
    return mine.slug;
  }

  let candidate = base;
  let n = 2;
  // Evita slugs reservados e colisões
  while (taken.has(candidate) || isReservedSlug(candidate)) {
    candidate = `${base}${n}`.slice(0, 48);
    n += 1;
    if (n > 9999) {
      candidate = `${base}${String(userId || '').replace(/-/g, '').slice(0, 6)}`.slice(0, 48);
      break;
    }
  }
  return candidate;
}

/** Persiste o slug da loja (único). */
export async function setCatalogSlug(userId, slug) {
  if (!admin || !userId || !slug) return false;
  const normalized = normalizeSlug(slug);
  if (isReservedSlug(normalized)) throw new Error('Este endereço (slug) é reservado. Escolha outro.');
  if (!normalized) return false;

  const existing = await listCatalogSlugs();
  const conflict = existing.find((e) => e.slug === normalized && e.user_id !== userId);
  if (conflict) {
    throw new Error('Este link de catálogo já está em uso por outra loja');
  }

  try {
    // Remove registros antigos deste usuário
    const { data: old } = await admin
      .from('operational_log')
      .select('id,description')
      .eq('type', CATALOG_SLUG_TYPE)
      .limit(2000);
    const toDelete = (old || []).filter((row) => {
      try {
        const p = JSON.parse(row.description || '{}');
        return p?.user_id === userId;
      } catch {
        return false;
      }
    });
    if (toDelete.length) {
      await admin.from('operational_log').delete().in('id', toDelete.map((r) => r.id));
    }

    await admin.from('operational_log').insert({
      type: CATALOG_SLUG_TYPE,
      level: 'info',
      description: JSON.stringify({ user_id: userId, slug: normalized }),
      operator_name: 'system',
    });
    return true;
  } catch (e) {
    console.error('setCatalogSlug', e.message || e);
    throw e;
  }
}

/** Retorna o slug da loja do usuário (cria se ainda não existir). */
export async function ensureCatalogSlug(userId, companyName) {
  if (!userId) return null;
  const existing = await listCatalogSlugs();
  const mine = existing.find((e) => e.user_id === userId);
  if (mine?.slug) return mine.slug;

  let name = companyName;
  if (!name && admin) {
    try {
      const { data: p } = await admin.from('profiles').select('company_name').eq('id', userId).maybeSingle();
      name = p?.company_name || null;
    } catch { /* ignore */ }
  }
  const slug = await generateUniqueCatalogSlug(name, userId);
  await setCatalogSlug(userId, slug);
  return slug;
}

/** Resolve loja a partir do slug do catálogo. Retorna { userId, slug } ou null. */
export async function resolveStoreBySlug(slug) {
  if (!slug) return null;
  const normalized = normalizeSlug(slug);
  const compact = normalized.replace(/-/g, '');
  if (!normalized && !compact) return null;
  if (isReservedSlug(normalized)) return null;
  const existing = await listCatalogSlugs();
  const hit = existing.find((e) => {
    const es = normalizeSlug(e.slug);
    return es === normalized || es.replace(/-/g, '') === compact || String(e.slug).toLowerCase() === compact;
  });
  if (!hit) return null;
  return { userId: hit.user_id, slug: hit.slug };
}

/** Lê a política "vender sem estoque" (PDV + catálogo). Opcionalmente por loja (userId). */
export async function getAllowZeroStock(userId = null) {
  if (!admin) return false;
  try {
    let q = admin.from('app_settings').select('*').order('created_at', { ascending: false }).limit(1);
    if (userId) q = admin.from('app_settings').select('*').eq('created_by', userId).order('created_at', { ascending: false }).limit(1);
    const { data: settingsList } = await q;
    const s = settingsList?.[0];
    if (s && Object.prototype.hasOwnProperty.call(s, 'allow_zero_stock') && s.allow_zero_stock != null) {
      return s.allow_zero_stock === true || s.allow_zero_stock === 'true' || s.allow_zero_stock === 1;
    }
    const { data: logs } = await admin
      .from('operational_log')
      .select('description')
      .eq('type', ZERO_STOCK_SETTING_TYPE)
      .order('created_at', { ascending: false })
      .limit(1);
    if (logs?.[0]?.description) {
      try {
        const parsed = JSON.parse(logs[0].description);
        return parsed?.allow_zero_stock === true;
      } catch {
        return logs[0].description === 'true';
      }
    }
  } catch (e) {
    console.error('getAllowZeroStock', e.message || e);
  }
  return false;
}

/** Persiste a política global "vender sem estoque". */
export async function setAllowZeroStock(value) {
  if (!admin) return false;
  const enabled = value === true;
  try {
    const { data: settingsList } = await admin
      .from('app_settings')
      .select('id')
      .order('created_at', { ascending: false })
      .limit(1);
    const id = settingsList?.[0]?.id;
    if (id) {
      const { error } = await admin
        .from('app_settings')
        .update({ allow_zero_stock: enabled })
        .eq('id', id);
      if (!error) return true;
      console.warn('setAllowZeroStock app_settings', error.message);
    }
  } catch (e) {
    console.warn('setAllowZeroStock app_settings', e.message || e);
  }
  try {
    await admin.from('operational_log').insert({
      type: ZERO_STOCK_SETTING_TYPE,
      level: 'info',
      description: JSON.stringify({ allow_zero_stock: enabled }),
      operator_name: 'system',
    });
    return true;
  } catch (e) {
    console.error('setAllowZeroStock fallback', e.message || e);
    return false;
  }
}

/**
 * Verifica se a entrega está pausada no momento (intervalo do entregador).
 * cfg: objeto de app_settings
 * Retorna { paused: boolean, message: string }
 */
export function getDeliveryPauseStatus(cfg) {
  const enabled = cfg?.delivery_pause_enabled === true;
  if (!enabled) {
    return { paused: false, message: '' };
  }

  const startStr = String(cfg?.delivery_pause_start || '12:00').trim();
  const endStr = String(cfg?.delivery_pause_end || '13:30').trim();
  const message =
    cfg?.delivery_pause_message ||
    'Entregas pausadas neste horário (intervalo do entregador). Retirada na loja disponível.';

  // Parse HH:MM
  const parseHM = (s) => {
    const m = s.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    return h * 60 + min;
  };

  const startMin = parseHM(startStr);
  const endMin = parseHM(endStr);
  if (startMin == null || endMin == null) {
    return { paused: false, message: '' };
  }

  // Hora atual em America/Sao_Paulo
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value || 0);
  const nowMin = hour * 60 + minute;

  let paused = false;
  if (startMin <= endMin) {
    // Intervalo normal (ex: 12:00-13:30)
    paused = nowMin >= startMin && nowMin < endMin;
  } else {
    // Intervalo que cruza meia-noite (ex: 23:00-01:00)
    paused = nowMin >= startMin || nowMin < endMin;
  }

  return { paused, message: paused ? message : '' };
}


/** Só dígitos */
export function onlyDigits(v) {
  return String(v || '').replace(/\D/g, '');
}

/** Telefone BR normalizado (sem DDI 55) */
export function normalizePhoneBR(v) {
  let p = onlyDigits(v);
  if (p.startsWith('55') && p.length >= 12) p = p.slice(2);
  if (p.startsWith('0') && p.length > 10) p = p.replace(/^0+/, '');
  return p;
}

/** CNPJ/CPF só dígitos */
export function normalizeDoc(v) {
  return onlyDigits(v);
}

/**
 * Upsert fornecedor da loja.
 * Match seguro: CNPJ exato (14 dígitos). Sem CNPJ: nome exatamente igual (case-insensitive) na mesma loja.
 * Nunca une dois CNPJs diferentes no mesmo registro.
 */
export async function upsertSupplier(userId, data = {}) {
  if (!admin || !userId) return null;
  const name = String(data.name || data.nome || '').trim();
  const cnpj = normalizeDoc(data.cnpj || data.doc || data.issuer_cnpj || '');
  if (!name && !cnpj) return null;

  try {
    let match = null;
    if (cnpj && cnpj.length >= 11) {
      const { data: rows } = await admin
        .from('supplier')
        .select('*')
        .eq('created_by', userId)
        .limit(2000);
      match = (rows || []).find((s) => normalizeDoc(s.cnpj) === cnpj) || null;
    }
    if (!match && name) {
      const { data: rows } = await admin
        .from('supplier')
        .select('*')
        .eq('created_by', userId)
        .ilike('name', name)
        .limit(10);
      // exige igualdade ignorando case (ilike sem % já é exact case-insensitive no PostgREST? 
      // ilike sem wildcards = exact CI)
      match = (rows || []).find((s) => String(s.name || '').trim().toLowerCase() === name.toLowerCase()) || null;
      // se o match tem CNPJ diferente do informado, NÃO reutiliza
      if (match && cnpj && match.cnpj && normalizeDoc(match.cnpj) !== cnpj) {
        match = null;
      }
    }

    const patch = {};
    if (name) patch.name = name;
    if (cnpj && cnpj.length >= 11) patch.cnpj = cnpj;
    if (data.phone) patch.phone = normalizePhoneBR(data.phone) || data.phone;
    if (data.email) patch.email = data.email;
    if (data.ie) patch.ie = data.ie;
    if (data.fantasy_name) patch.fantasy_name = data.fantasy_name;
    if (data.street) patch.street = data.street;
    if (data.city) patch.city = data.city;
    if (data.state) patch.state = data.state;
    if (data.cep) patch.cep = onlyDigits(data.cep);

    if (match) {
      // só preenche campos vazios (não sobrescreve dados bons)
      const updates = {};
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === '') continue;
        if (!match[k]) updates[k] = v;
      }
      // CNPJ: se match não tinha e agora tem, grava
      if (cnpj && !match.cnpj) updates.cnpj = cnpj;
      if (Object.keys(updates).length) {
        await admin.from('supplier').update(updates).eq('id', match.id);
      }
      return match.id;
    }

    const insert = {
      name: name || `Fornecedor ${cnpj}`,
      cnpj: cnpj || null,
      phone: patch.phone || null,
      email: patch.email || null,
      ie: patch.ie || null,
      fantasy_name: patch.fantasy_name || null,
      created_by: userId,
    };
    const { data: created, error } = await admin.from('supplier').insert(insert).select('id').maybeSingle();
    if (error) {
      console.warn('upsertSupplier insert', error.message);
      return null;
    }
    return created?.id || null;
  } catch (e) {
    console.warn('upsertSupplier', e?.message || e);
    return null;
  }
}

/**
 * Upsert cliente da loja.
 * Match seguro: telefone normalizado (com/sem 55) OU email exato.
 * NUNCA casa só por nome (evita misturar pessoas diferentes).
 */
export async function upsertCustomer(userId, data = {}) {
  if (!admin || !userId) return null;
  const name = String(data.name || data.customer_name || '').trim();
  const phone = normalizePhoneBR(data.phone || data.customer_phone || data.whatsapp || '');
  const email = String(data.email || '').trim().toLowerCase();
  if (!name && !phone && !email) return null;

  try {
    let match = null;

    if (phone && phone.length >= 10) {
      // Busca na loja e compara telefone normalizado em memória (mais confiável)
      const { data: rows } = await admin
        .from('customer')
        .select('*')
        .eq('created_by', userId)
        .limit(3000);
      match = (rows || []).find((cu) => {
        const p = normalizePhoneBR(cu.phone || cu.whatsapp);
        return p && p === phone;
      }) || null;
    }

    if (!match && email && email.includes('@')) {
      const { data: rows } = await admin
        .from('customer')
        .select('*')
        .eq('created_by', userId)
        .ilike('email', email)
        .limit(5);
      match = (rows || []).find((cu) => String(cu.email || '').trim().toLowerCase() === email) || null;
    }

    const patch = {};
    if (name) patch.name = name;
    if (phone) patch.phone = phone;
    if (phone) patch.whatsapp = phone;
    if (email) patch.email = email;
    if (data.street || data.delivery_address) patch.street = data.street || data.delivery_address;
    if (data.number || data.delivery_number) patch.number = data.number || data.delivery_number;
    if (data.complement || data.delivery_complement) patch.complement = data.complement || data.delivery_complement;
    if (data.neighborhood || data.delivery_neighborhood) patch.neighborhood = data.neighborhood || data.delivery_neighborhood;
    if (data.city || data.delivery_city) patch.city = data.city || data.delivery_city;
    if (data.state || data.delivery_state) patch.state = data.state || data.delivery_state;
    if (data.cep || data.delivery_cep) patch.cep = onlyDigits(data.cep || data.delivery_cep);
    if (data.doc || data.cpf || data.cnpj) {
      const doc = normalizeDoc(data.doc || data.cpf || data.cnpj);
      if (doc) patch.doc = doc;
    }

    if (match) {
      const updates = {};
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === '') continue;
        if (!match[k]) updates[k] = v;
      }
      // nome muito genérico no cadastro → atualiza se veio nome melhor
      if (name && name.length >= 3 && (!match.name || match.name.length < 3)) {
        updates.name = name;
      }
      if (Object.keys(updates).length) {
        await admin.from('customer').update(updates).eq('id', match.id);
      }
      return match.id;
    }

    // Sem telefone nem email confiável: não cria (evita duplicata sem chave)
    if ((!phone || phone.length < 10) && !email) {
      return null;
    }

    const insert = {
      name: name || (phone ? `Cliente ${phone}` : email),
      person_type: (patch.doc && String(patch.doc).length > 11) ? 'juridica' : 'fisica',
      phone: phone || null,
      whatsapp: phone || null,
      email: email || null,
      street: patch.street || null,
      number: patch.number || null,
      complement: patch.complement || null,
      neighborhood: patch.neighborhood || null,
      city: patch.city || null,
      state: patch.state || null,
      cep: patch.cep || null,
      doc: patch.doc || null,
      active: true,
      created_by: userId,
    };
    const { data: created, error } = await admin.from('customer').insert(insert).select('id').maybeSingle();
    if (error) {
      console.warn('upsertCustomer insert', error.message);
      return null;
    }
    return created?.id || null;
  } catch (e) {
    console.warn('upsertCustomer', e?.message || e);
    return null;
  }
}
