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

  return {
    id: user.id,
    email: user.email,
    role: profile?.role || 'admin',
    company_name: profile?.company_name || null,
    company_cnpj: profile?.company_cnpj || null,
    company_phone: profile?.company_phone || null,
    company_instagram: profile?.company_instagram || null,
    company_address: profile?.company_address || null,
    referral_code: profile?.referral_code || null,
    full_name: profile?.company_name || user.email,
    data: profile || {},
  };
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

  // Conta nova começa zerada: cria AppSettings próprio
  try {
    await admin.from('app_settings').insert({
      created_by: data.user.id,
      company_name: extra.company_name || null,
      catalog_enabled: true,
      catalog_max_qty_per_product: 10,
      catalog_stock_reserve: 0,
    });
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
  // company_address pode não existir na tabela — tentamos e removemos se falhar
  const allowed = ['company_name', 'company_cnpj', 'company_phone', 'company_instagram', 'company_address', 'role']; // referral_code é imutável
  const patch = {};
  for (const k of allowed) {
    if (k in body) patch[k] = body[k] === '' ? null : body[k];
  }

  const shape = (p) => ({
    id: user.id,
    email: user.email,
    role: p?.role || user.role || 'admin',
    company_name: p?.company_name ?? null,
    company_cnpj: p?.company_cnpj ?? null,
    company_phone: p?.company_phone ?? null,
    company_instagram: p?.company_instagram ?? null,
    company_address: p?.company_address ?? null,
    referral_code: p?.referral_code ?? null,
    full_name: p?.company_name || user.email,
    data: p || {},
  });

  if (useLocal) {
    const keys = Object.keys(patch);
    if (!keys.length) return c.json(shape(user.data || user));
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const vals = keys.map((k) => patch[k]);
    const { rows } = await query(
      `update profiles set ${sets}, updated_at = now() where id = $1 returning *`,
      [user.id, ...vals]
    );
    return c.json(shape(rows[0] || {}));
  }

  if (!Object.keys(patch).length) return c.json(shape(user.data || {}));

  // Remove company_address se a coluna não existir (detectado em runtime)
  const tryUpdate = async (fields) => {
    const { data, error } = await admin
      .from('profiles')
      .update(fields)
      .eq('id', user.id)
      .select()
      .maybeSingle();
    return { data, error };
  };

  let fields = { ...patch };
  let { data, error } = await tryUpdate(fields);

  if (error && String(error.message || '').includes('company_address')) {
    delete fields.company_address;
    ({ data, error } = await tryUpdate(fields));
  }

  // Perfil inexistente → tenta INSERT
  if (!error && !data) {
    const insertPayload = {
      id: user.id,
      email: user.email,
      role: user.role || 'admin',
      ...fields,
    };
    ({ data, error } = await admin.from('profiles').insert(insertPayload).select().maybeSingle());
    if (error && String(error.message || '').includes('company_address')) {
      delete insertPayload.company_address;
      ({ data, error } = await admin.from('profiles').insert(insertPayload).select().maybeSingle());
    }
  }

  if (error) return c.json({ error: error.message }, 400);
  if (!data) {
    // Fallback: re-lê o que existir
    const { data: again } = await admin.from('profiles').select('*').eq('id', user.id).maybeSingle();
    data = again || { ...user.data, ...fields };
  }

  // Espelha nome da empresa no AppSettings (catálogo / recibos)
  if (patch.company_name) {
    try {
      const { data: settings } = await admin
        .from('app_settings')
        .select('id')
        .eq('created_by', user.id)
        .order('created_at', { ascending: false })
        .limit(1);
      if (settings?.[0]?.id) {
        await admin.from('app_settings').update({ company_name: patch.company_name }).eq('id', settings[0].id);
      }
    } catch (e) {
      console.warn('sync app_settings company_name', e.message);
    }
    // Atualiza slug do catálogo se o nome da loja mudou (mantém unicidade)
    try {
      const { generateUniqueCatalogSlug, setCatalogSlug } = await import('./helpers.js');
      const newSlug = await generateUniqueCatalogSlug(patch.company_name, user.id);
      await setCatalogSlug(user.id, newSlug);
    } catch (e) {
      console.warn('catalog slug on company_name change', e.message || e);
    }
  }

  return c.json(shape(data || payload));
});

auth.post('/oauth', async (c) => {
  if (useLocal) {
    return c.json({
      error: 'oauth_not_available_local',
      message: 'Google OAuth requer modo Supabase. Use e-mail/senha no modo local.',
    }, 501);
  }
  const { provider, redirect_to } = await c.req.json();
  if (!admin) return c.json({ error: 'db_unavailable' }, 503);
  const { data, error } = await admin.auth.signInWithOAuth({
    provider,
    options: { redirectTo: redirect_to },
  });
  if (error) return c.json({ error: error.message }, 400);
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
