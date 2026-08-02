import { Hono } from 'hono';
import { admin, useLocal, query } from './db.js';
import { requireUser, getAllowZeroStock, setAllowZeroStock } from './helpers.js';

const adminOps = new Hono();

/** Política global: vender sem estoque (PDV + catálogo) */
adminOps.post('/stock-policy', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.allow_zero_stock === 'boolean') {
      if (user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403);
      const ok = await setAllowZeroStock(body.allow_zero_stock);
      if (!ok) return c.json({ error: 'Falha ao salvar configuração' }, 500);
    }
    const allow_zero_stock = await getAllowZeroStock();
    return c.json({ allow_zero_stock });
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

adminOps.get('/stock-policy', async (c) => {
  try {
    const allow_zero_stock = await getAllowZeroStock();
    return c.json({ allow_zero_stock });
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

/**
 * Backup das tabelas principais → bucket privado "backups" no Supabase Storage.
 * Auth: usuário admin logado OU header x-backup-secret = BACKUP_SECRET (ou JWT_SECRET).
 */
adminOps.post('/create-backup', async (c) => {
  try {
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);
    const secret = c.req.header('x-backup-secret') || '';
    const expected = process.env.BACKUP_SECRET || process.env.JWT_SECRET || '';
    let allowed = expected && secret && secret === expected;
    if (!allowed) {
      const user = await requireUser(c);
      allowed = !!(user && user.role === 'admin');
    }
    if (!allowed) return c.json({ error: 'Unauthorized' }, 401);

    const tables = [
      'product', 'customer', 'seller', 'sale', 'courier',
      'delivery_fee', 'app_settings', 'cash_session', 'notification',
    ];
    const payload = { created_at: new Date().toISOString(), tables: {} };
    for (const table of tables) {
      const { data, error } = await admin.from(table).select('*').limit(10000);
      if (error) {
        payload.tables[table] = { error: error.message };
      } else {
        payload.tables[table] = data || [];
      }
    }

    const date = new Date().toISOString().slice(0, 10);
    const fileName = `darocha-backup-${date}-${Date.now()}.json`;
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    // Garante bucket
    await fetch(`${supabaseUrl}/storage/v1/bucket`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ id: 'backups', name: 'backups', public: false }),
    }).catch(() => null);

    const up = await fetch(`${supabaseUrl}/storage/v1/object/backups/${fileName}`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'x-upsert': 'true',
      },
      body,
    });
    if (!up.ok) {
      const t = await up.text();
      return c.json({ error: 'upload_failed', detail: t }, 500);
    }

    const counts = {};
    for (const [k, v] of Object.entries(payload.tables)) {
      counts[k] = Array.isArray(v) ? v.length : 0;
    }
    return c.json({ ok: true, file: fileName, counts });
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

adminOps.post('/admin-stats', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    if (user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403);
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayIso = today.toISOString();

    const { data: sales } = await admin.from('sale').select('id,total,status,created_at,source').limit(5000);
    const { data: products } = await admin.from('product').select('id,stock,active').limit(5000);
    const { data: sessions } = await admin.from('cash_session').select('id,status').eq('status', 'aberto');
    const { data: customers } = await admin.from('customer').select('id').limit(10000);

    const allSales = sales || [];
    const todaySales = allSales.filter((s) => s.created_at >= todayIso && s.status !== 'cancelado');
    const revenueToday = todaySales.reduce((a, s) => a + (Number(s.total) || 0), 0);
    const lowStock = (products || []).filter((p) => p.active !== false && (Number(p.stock) || 0) <= 5).length;

    return c.json({
      sales_today: todaySales.length,
      revenue_today: Math.round(revenueToday * 100) / 100,
      open_sessions: (sessions || []).length,
      products: (products || []).length,
      low_stock: lowStock,
      customers: (customers || []).length,
      sales_total: allSales.filter((s) => s.status !== 'cancelado').length,
    });
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

adminOps.post('/cleanup-cash-sessions', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);

    const body = await c.req.json().catch(() => ({}));
    const staleMinutes = Number(body.stale_minutes) || 120;
    const cutoff = new Date(Date.now() - staleMinutes * 60000).toISOString();

    const { data: open } = await admin.from('cash_session').select('*').eq('status', 'aberto').limit(200);
    let closed = 0;
    for (const s of open || []) {
      const last = s.last_heartbeat || s.updated_at || s.created_at;
      if (last && last < cutoff) {
        await admin.from('cash_session').update({
          status: 'fechado',
          closed_at: new Date().toISOString(),
          close_reason: 'cleanup_stale',
        }).eq('id', s.id);
        closed++;
      }
    }
    return c.json({ ok: true, closed });
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

adminOps.post('/purge-account', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);

    const body = await c.req.json().catch(() => ({}));
    if (body.confirm !== true && body.confirm !== 'DELETE') {
      return c.json({ error: 'Confirmação necessária (confirm: true)' }, 400);
    }

    // Soft approach: anonymize profile; hard-delete optional
    if (useLocal) {
      await query(`update profiles set email = $1, password_hash = null, company_name = null where id = $2`, [
        `deleted_${user.id}@purged.local`,
        user.id,
      ]);
    } else {
      await admin.from('profiles').update({
        email: `deleted_${user.id}@purged.local`,
        company_name: null,
        company_phone: null,
      }).eq('id', user.id);
      try {
        await admin.auth.admin.deleteUser(user.id);
      } catch (e) {
        console.error('deleteUser', e);
      }
    }

    return c.json({ ok: true });
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

adminOps.post('/init-help-content', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);

    const defaults = [
      { title: 'Como abrir o caixa', category: 'pdv', content: 'Acesse o PDV e clique em Abrir Caixa informando o valor inicial.', sort_order: 1 },
      { title: 'Como fazer uma venda', category: 'pdv', content: 'Busque o produto pelo nome ou código de barras, adicione ao carrinho e finalize o pagamento.', sort_order: 2 },
      { title: 'Catálogo online', category: 'catalogo', content: 'Ative o catálogo em Configurações. Clientes compram online e pagam na entrega/retirada.', sort_order: 3 },
      { title: 'Balanço de estoque', category: 'estoque', content: 'Use Contagem de Estoque, conte os itens e aplique o balanço para ajustar o sistema.', sort_order: 4 },
    ];

    const { data: existing } = await admin.from('help_article').select('id').limit(1);
    if (existing?.length) return c.json({ ok: true, skipped: true });

    for (const a of defaults) {
      await admin.from('help_article').insert({ ...a, active: true });
    }
    return c.json({ ok: true, inserted: defaults.length });
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

export default adminOps;
