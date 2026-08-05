import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import { admin, userClient, useLocal, query } from './db.js';

const auth = new Hono();
const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || 'darocha-dev-secret-change-me-in-prod-32'
);

async function signToken(payload) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(JWT_SECRET);
}

export async function verifyToken(token) {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return payload;
  } catch {
    return null;
  }
}

export async function getUserFromRequest(c) {
  const header = c.req.header('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;

  if (useLocal) {
    const payload = await verifyToken(token);
    if (!payload?.sub) return null;
    const { rows } = await query(
      `select id, email, role, company_name, company_cnpj, company_phone, company_instagram, referral_code
       from profiles where id = $1`,
      [payload.sub]
    );
    const p = rows[0];
    if (!p) return null;
    return {
      id: p.id,
      email: p.email,
      role: p.role || 'admin',
      company_name: p.company_name,
      company_cnpj: p.company_cnpj,
      company_phone: p.company_phone,
      company_instagram: p.company_instagram,
      referral_code: p.referral_code,
      full_name: p.company_name || p.email,
      data: p,
    };
  }

  if (!admin) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return null;
  const user = data.user;

  let { data: profile } = await admin.from('profiles').select('*').eq('id', user.id).maybeSingle();

  // Garante perfil (usuários antigos / login sem register completo)
  if (!profile) {
    const seed = {
      id: user.id,
      email: user.email,
      role: 'admin',
      company_name: user.user_metadata?.company_name || null,
      company_cnpj: user.user_metadata?.company_cnpj || null,
      company_phone: user.user_metadata?.company_phone || null,
    };
    // Service role às vezes ainda esbarra em RLS no INSERT; tenta e segue com seed em memória
    const { data: created, error: cErr } = await admin.from('profiles').insert(seed).select().maybeSingle();
    if (cErr) {
      console.warn('profile seed insert', cErr.message);
      profile = seed;
    } else {
      profile = created || seed;
    }
  }

  // referral_code: não bloqueia /auth/me (evita tela branca se PostgREST/RLS travar)
  let referralCode = profile?.referral_code || null;
  if (!referralCode && profile?.id) {
    // fire-and-forget com timeout interno do restQuery
    import('./stripe_ops.js')
      .then(({ ensureUserReferralCode }) => ensureUserReferralCode(user.id))
      .then((code) => {
        if (code) console.log('referral_code backfilled for', user.id);
      })
      .catch((e) => console.warn('ensure referral on me', e.message || e));
  }

  const base = {
    id: user.id,
    email: user.email,
    role: profile?.role || 'admin',
    company_name: profile?.company_name || null,
    company_cnpj: profile?.company_cnpj || null,
    company_phone: profile?.company_phone || null,
    company_instagram: profile?.company_instagram || null,
    company_address: profile?.company_address || null,
    referral_code: referralCode,
    referred_by_code: profile?.referred_by_code || null,
    full_name: profile?.company_name || user.email,
    data: profile || {},
  };
  try {
    const { ensureCatalogSlug } = await import('./helpers.js');
    const slugPromise = ensureCatalogSlug(user.id, profile?.company_name || null);
    const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(null), 5000));
    const slug = await Promise.race([slugPromise, timeoutPromise]);
    base.catalog_slug = slug;
    const { buildStorePublicUrl } = await import('./helpers.js');
    base.catalog_url = slug ? buildStorePublicUrl(slug) : null;
  } catch (e) {
    console.warn('catalog slug on me', e.message || e);
    base.catalog_slug = null;
    base.catalog_url = null;
  }
  return base;
}

auth.get('/me', async (c) => {
  const user = await getUserFromRequest(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  return c.json(user);
});

auth.post('/login', async (c) => {
  const { email, password } = await c.req.json();
  if (!email || !password) return c.json({ error: 'email_password_required' }, 400);

  if (useLocal) {
    const { rows } = await query(`select * from profiles where lower(email) = lower($1)`, [email]);
    const p = rows[0];
    if (!p?.password_hash) return c.json({ error: 'Invalid login credentials' }, 401);
    const ok = await bcrypt.compare(password, p.password_hash);
    if (!ok) return c.json({ error: 'Invalid login credentials' }, 401);
    const token = await signToken({ sub: p.id, email: p.email, role: p.role });
    return c.json({
      token,
      user: { id: p.id, email: p.email, role: p.role, company_name: p.company_name },
    });
  }

  if (!admin) return c.json({ error: 'db_unavailable' }, 503);
  const { data, error } = await admin.auth.signInWithPassword({ email, password });
  if (error) return c.json({ error: error.message }, 401);
  return c.json({
    token: data.session?.access_token,
    refresh_token: data.session?.refresh_token,
    user: data.user,
  });
});

auth.post('/register', async (c) => {
  const body = await c.req.json();
  const { email, password, ...extra } = body;
  if (!email || !password) return c.json({ error: 'email_password_required' }, 400);
  if (String(password).length < 6) return c.json({ error: 'password_too_short' }, 400);

  if (useLocal) {
    const hash = await bcrypt.hash(password, 10);
    try {
      const { rows } = await query(
        `insert into profiles (email, password_hash, role, company_name, company_phone, company_cnpj)
         values ($1, $2, $3, $4, $5, $6)
         returning id, email, role, company_name`,
        [
          email.toLowerCase(),
          hash,
          extra.role || 'admin',
          extra.company_name || null,
          extra.company_phone || null,
          extra.company_cnpj || null,
        ]
      );
      const p = rows[0];
      const token = await signToken({ sub: p.id, email: p.email, role: p.role });
      return c.json({ token, user: p }, 201);
    } catch (e) {
      if (String(e.message).includes('unique')) {
        return c.json({ error: 'Email already registered' }, 400);
      }
      return c.json({ error: e.message }, 400);
    }
  }

  if (!admin) return c.json({ error: 'db_unavailable' }, 503);
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: extra,
  });
  if (error) return c.json({ error: error.message }, 400);
  await admin.from('profiles').upsert({
    id: data.user.id,
    email,
    role: extra.role || 'admin',
    company_name: extra.company_name || null,
    company_cnpj: extra.company_cnpj || null,
    company_phone: extra.company_phone || null,
  });

  // Conta nova: AppSettings + catálogo habilitado (REST fallback se RLS travar)
  try {
    const seedSettings = {
      created_by: data.user.id,
      company_name: extra.company_name || null,
      catalog_enabled: true,
      catalog_max_qty_per_product: 10,
      catalog_stock_reserve: 0,
      printer_print_mode: 'ask',
      printer_copies: 1,
    };
    const { error: sErr } = await admin.from('app_settings').insert(seedSettings);
    if (sErr) {
      console.warn('app_settings seed admin', sErr.message);
      try {
        const { restQuery } = await import('./db.js');
        await restQuery('app_settings', { method: 'POST', body: seedSettings, prefer: 'return=minimal' });
      } catch (e2) {
        console.warn('app_settings seed rest', e2.message || e2);
      }
    }
  } catch (e) {
    console.warn('app_settings seed on register', e.message || e);
  }

  // Slug único do catálogo público (baseado no nome da loja)
  try {
    const { ensureCatalogSlug } = await import('./helpers.js');
    await ensureCatalogSlug(data.user.id, extra.company_name || null);
  } catch (e) {
    console.warn('catalog slug on register', e.message || e);
  }

  // Trial 30 dias + código de indicação + vínculo de referral
  try {
    const { bootstrapNewUserSubscription } = await import('./stripe_ops.js');
    const referralUsed = extra.referral_code || extra.referralCode || body.referral_code || null;
    await bootstrapNewUserSubscription(data.user.id, email, referralUsed);
  } catch (e) {
    console.warn('subscription bootstrap on register', e.message || e);
  }

  const login = await admin.auth.signInWithPassword({ email, password });
  return c.json({ token: login.data.session?.access_token, user: data.user }, 201);
});

auth.post('/logout', async (c) => c.json({ ok: true }));


auth.patch('/me', async (c) => {
  const user = await getUserFromRequest(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({}));

  // Colunas reais da tabela profiles (company_address NÃO existe no schema atual)
  const allowed = ['company_name', 'company_cnpj', 'company_phone', 'company_instagram', 'role'];
  const patch = {};
  for (const k of allowed) {
    if (k in body) patch[k] = body[k] === '' ? null : body[k];
  }
  // Endereço: aceita no payload para não quebrar o frontend, mas só persiste se a coluna existir
  const requestedAddress = Object.prototype.hasOwnProperty.call(body, 'company_address')
    ? (body.company_address === '' ? null : body.company_address)
    : undefined;

  const shape = (p, addressOverride) => ({
    id: user.id,
    email: user.email,
    role: p?.role || user.role || 'admin',
    company_name: p?.company_name ?? null,
    company_cnpj: p?.company_cnpj ?? null,
    company_phone: p?.company_phone ?? null,
    company_instagram: p?.company_instagram ?? null,
    company_address: addressOverride !== undefined ? addressOverride : (p?.company_address ?? null),
    referral_code: p?.referral_code ?? null,
    full_name: p?.company_name || user.email,
    data: p || {},
  });

  if (useLocal) {
    const keys = Object.keys(patch);
    if (!keys.length && requestedAddress === undefined) return c.json(shape(user.data || user));
    try {
      if (keys.length) {
        const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
        const vals = keys.map((k) => patch[k]);
        const { rows } = await query(
          `update profiles set ${sets}, updated_at = now() where id = $1 returning *`,
          [user.id, ...vals]
        );
        return c.json(shape(rows[0] || {}, requestedAddress !== undefined ? requestedAddress : undefined));
      }
      return c.json(shape(user.data || user, requestedAddress));
    } catch (e) {
      return c.json({ error: e.message || 'Falha ao salvar perfil' }, 400);
    }
  }

  if (!admin) return c.json({ error: 'db_unavailable' }, 503);

  if (!Object.keys(patch).length && requestedAddress === undefined) {
    return c.json(shape(user.data || {}));
  }

  const tryUpdate = async (fields) => {
    const { data, error } = await admin
      .from('profiles')
      .update(fields)
      .eq('id', user.id)
      .select('*')
      .maybeSingle();
    return { data, error };
  };

  let fields = { ...patch };
  // Tenta incluir endereço; se a coluna não existir, remove e segue
  if (requestedAddress !== undefined) {
    fields.company_address = requestedAddress;
  }

  let data = null;
  let error = null;

  if (Object.keys(fields).length) {
    ({ data, error } = await tryUpdate(fields));
    const msg = String(error?.message || error?.details || error?.hint || '');
    if (error && (msg.includes('company_address') || msg.includes('schema cache') || msg.includes('column'))) {
      delete fields.company_address;
      if (Object.keys(fields).length) {
        ({ data, error } = await tryUpdate(fields));
      } else {
        error = null;
      }
    }
  }

  // NUNCA faz INSERT se o perfil já existe — só relê (evita erro de RLS)
  if (!error && !data) {
    const { data: again, error: readErr } = await admin
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .maybeSingle();
    if (readErr) {
      return c.json({ error: readErr.message }, 400);
    }
    data = again || { ...(user.data || {}), ...fields, id: user.id, email: user.email };
  }

  if (error) {
    console.error('auth.patch /me', error);
    return c.json({ error: error.message || 'Falha ao salvar dados da empresa' }, 400);
  }

  // Espelha dados no AppSettings (catálogo / recibos)
  try {
    const settingsPatch = {};
    if (patch.company_name !== undefined) settingsPatch.company_name = patch.company_name;
    if (Object.keys(settingsPatch).length) {
      const { data: settings } = await admin
        .from('app_settings')
        .select('id')
        .eq('created_by', user.id)
        .order('created_at', { ascending: false })
        .limit(5);
      for (const row of settings || []) {
        await admin.from('app_settings').update(settingsPatch).eq('id', row.id);
      }
    }
  } catch (e) {
    console.warn('sync app_settings company', e.message);
  }

  // Atualiza slug do catálogo se o nome mudou (não bloqueia o save)
  if (patch.company_name) {
    try {
      const { generateUniqueCatalogSlug, setCatalogSlug } = await import('./helpers.js');
      const newSlug = await generateUniqueCatalogSlug(patch.company_name, user.id);
      await setCatalogSlug(user.id, newSlug);
    } catch (e) {
      console.warn('catalog slug on company_name change', e.message || e);
    }
  }

  return c.json(shape(data, requestedAddress !== undefined ? requestedAddress : undefined));
});

/** Lista provedores OAuth habilitados no Supabase (público) */
auth.get('/providers', async (c) => {
  try {
    if (useLocal || !process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
      return c.json({ google: false, email: true, mode: 'local' });
    }
    const base = process.env.SUPABASE_URL.replace(/\/$/, '');
    const res = await fetch(`${base}/auth/v1/settings`, {
      headers: {
        apikey: process.env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
      },
    });
    if (!res.ok) {
      return c.json({ google: false, email: true, error: 'settings_unavailable' });
    }
    const settings = await res.json();
    const ext = settings.external || {};
    return c.json({
      google: ext.google === true,
      email: ext.email !== false,
      apple: ext.apple === true,
    });
  } catch (e) {
    return c.json({ google: false, email: true, error: e.message });
  }
});

auth.post('/oauth', async (c) => {
  if (useLocal) {
    return c.json({
      error: 'oauth_not_available_local',
      message: 'Google OAuth requer modo Supabase. Use e-mail/senha no modo local.',
    }, 501);
  }
  const body = await c.req.json().catch(() => ({}));
  const provider = String(body.provider || 'google').toLowerCase();
  const redirect_to = body.redirect_to;
  if (!admin) return c.json({ error: 'db_unavailable' }, 503);

  // Confere se o provedor está ligado no Supabase (evita tela preta de erro)
  try {
    const base = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
    if (base && process.env.SUPABASE_ANON_KEY) {
      const res = await fetch(`${base}/auth/v1/settings`, {
        headers: {
          apikey: process.env.SUPABASE_ANON_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
        },
      });
      if (res.ok) {
        const settings = await res.json();
        const enabled = settings?.external?.[provider] === true;
        if (!enabled) {
          return c.json({
            error: 'provider_not_enabled',
            message:
              provider === 'google'
                ? 'Login com Google ainda não está ativado. Use e-mail e senha, ou ative o provedor Google no painel do Supabase (Authentication → Providers → Google) com Client ID e Secret do Google Cloud.'
                : `Provedor "${provider}" não está habilitado no Supabase.`,
          }, 400);
        }
      }
    }
  } catch (e) {
    console.warn('oauth provider check', e.message || e);
  }

  // Nunca redirecionar para localhost em produção (evita tela ERR_CONNECTION_REFUSED no celular)
  const APP = (process.env.APP_URL || 'https://dist-ten-mu-12.vercel.app').replace(/\/$/, '');
  let finalRedirect = (redirect_to || APP || '').toString();
  if (!finalRedirect || /localhost|127\.0\.0\.1|capacitor:\/\/|file:/i.test(finalRedirect)) {
    finalRedirect = APP + '/';
  }
  if (!finalRedirect.startsWith('http')) finalRedirect = APP + '/';
  // Garante origem permitida
  try {
    const u = new URL(finalRedirect);
    if (!u.hostname.includes('vercel.app') && u.hostname !== 'dist-ten-mu-12.vercel.app') {
      finalRedirect = APP + '/';
    }
  } catch {
    finalRedirect = APP + '/';
  }

  const { data, error } = await admin.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: finalRedirect,
    },
  });
  if (error) {
    const msg = error.message || String(error);
    if (/provider is not enabled|Unsupported provider/i.test(msg)) {
      return c.json({
        error: 'provider_not_enabled',
        message:
          'Login com Google ainda não está ativado no Supabase. Use e-mail e senha por enquanto.',
      }, 400);
    }
    return c.json({ error: msg }, 400);
  }
  return c.json({ url: data.url });
});

auth.post('/reset-password', async (c) => {
  const { email, redirect_to } = await c.req.json();
  if (useLocal) {
    return c.json({
      ok: true,
      message: 'No modo local, altere a senha via SQL ou crie nova conta. Configure Supabase para e-mail de recovery.',
    });
  }
  if (!admin) return c.json({ error: 'db_unavailable' }, 503);
  const { error } = await admin.auth.resetPasswordForEmail(email, {
    redirectTo: redirect_to || process.env.APP_URL || 'http://localhost:5173/reset-password',
  });
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ ok: true });
});

auth.post('/reset-password/confirm', async (c) => {
  const user = await getUserFromRequest(c);
  const { password } = await c.req.json();
  if (!password || password.length < 6) return c.json({ error: 'password_too_short' }, 400);
  if (!user) return c.json({ error: 'token_required' }, 400);

  if (useLocal) {
    const hash = await bcrypt.hash(password, 10);
    await query(`update profiles set password_hash = $1, updated_at = now() where id = $2`, [
      hash,
      user.id,
    ]);
    return c.json({ ok: true });
  }

  const { error } = await admin.auth.admin.updateUserById(user.id, { password });
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ ok: true });
});

export default auth;
