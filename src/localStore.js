/**
 * Mini query builder no estilo Supabase para Postgres local.
 * admin.from('product').select('*').eq('id', x).maybeSingle()
 */
import { pool } from './db.js';

function isUuid(v) {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

class Query {
  constructor(table) {
    this.table = table;
    this._select = '*';
    this._filters = [];
    this._order = null;
    this._limit = null;
    this._offset = null;
    this._op = 'select';
    this._payload = null;
    this._inFilters = [];
    this._or = null;
    this._single = false;
    this._maybe = false;
  }

  select(cols = '*') {
    this._select = cols;
    return this;
  }

  eq(col, val) {
    this._filters.push({ col, op: '=', val });
    return this;
  }

  neq(col, val) {
    this._filters.push({ col, op: '<>', val });
    return this;
  }

  is(col, val) {
    this._filters.push({ col, op: 'is', val });
    return this;
  }

  in(col, vals) {
    this._inFilters.push({ col, vals });
    return this;
  }

  or(expr) {
    // simple: name.ilike.%x%,barcode.ilike.%x%
    this._or = expr;
    return this;
  }

  order(col, { ascending = true } = {}) {
    this._order = { col, ascending };
    return this;
  }

  limit(n) {
    this._limit = n;
    return this;
  }

  range(from, to) {
    this._offset = from;
    this._limit = to - from + 1;
    return this;
  }

  insert(payload) {
    this._op = 'insert';
    this._payload = payload;
    return this;
  }

  update(payload) {
    this._op = 'update';
    this._payload = payload;
    return this;
  }

  delete() {
    this._op = 'delete';
    return this;
  }

  upsert(payload, _opts) {
    this._op = 'upsert';
    this._payload = payload;
    return this;
  }

  single() {
    this._single = true;
    return this;
  }

  maybeSingle() {
    this._maybe = true;
    return this;
  }

  async then(resolve, reject) {
    try {
      const result = await this._run();
      resolve(result);
    } catch (e) {
      if (reject) reject(e);
      else resolve({ data: null, error: e });
    }
  }

  _where(params) {
    const parts = [];
    for (const f of this._filters) {
      if (f.op === 'is') {
        parts.push(`"${f.col}" is ${f.val === null ? 'null' : f.val}`);
      } else {
        params.push(f.val);
        parts.push(`"${f.col}" ${f.op} $${params.length}`);
      }
    }
    for (const f of this._inFilters) {
      params.push(f.vals);
      parts.push(`"${f.col}" = any($${params.length})`);
    }
    if (this._or) {
      // name.ilike.%q%,barcode.ilike.%q%
      const clauses = this._or.split(',').map((c) => {
        const m = c.match(/^(\w+)\.ilike\.%(.+)%$/);
        if (m) {
          params.push(`%${m[2]}%`);
          return `"${m[1]}" ilike $${params.length}`;
        }
        return 'true';
      });
      parts.push(`(${clauses.join(' or ')})`);
    }
    return parts.length ? ` where ${parts.join(' and ')}` : '';
  }

  async _run() {
    if (!pool) return { data: null, error: { message: 'no_pool' } };
    const params = [];

    if (this._op === 'select') {
      let sql = `select ${this._select === '*' ? '*' : this._select} from "${this.table}"`;
      sql += this._where(params);
      if (this._order) {
        sql += ` order by "${this._order.col}" ${this._order.ascending ? 'asc' : 'desc'}`;
      }
      if (this._limit != null) {
        params.push(this._limit);
        sql += ` limit $${params.length}`;
      }
      if (this._offset != null) {
        params.push(this._offset);
        sql += ` offset $${params.length}`;
      }
      const { rows } = await pool.query(sql, params);
      if (this._single) {
        if (!rows[0]) return { data: null, error: { message: 'not found' } };
        return { data: rows[0], error: null };
      }
      if (this._maybe) return { data: rows[0] || null, error: null };
      return { data: rows, error: null };
    }

    if (this._op === 'insert') {
      const rowsIn = Array.isArray(this._payload) ? this._payload : [this._payload];
      const out = [];
      for (const row of rowsIn) {
        const keys = Object.keys(row).filter((k) => row[k] !== undefined);
        const cols = keys.map((k) => `"${k}"`).join(', ');
        const ph = keys.map((_, i) => `$${i + 1}`).join(', ');
        const vals = keys.map((k) => {
          const v = row[k];
          if (v && typeof v === 'object') return JSON.stringify(v);
          return v;
        });
        const { rows } = await pool.query(
          `insert into "${this.table}" (${cols}) values (${ph}) returning *`,
          vals
        );
        out.push(rows[0]);
      }
      if (this._single || !Array.isArray(this._payload)) {
        return { data: out[0], error: null };
      }
      return { data: out, error: null };
    }

    if (this._op === 'update') {
      const keys = Object.keys(this._payload).filter((k) => this._payload[k] !== undefined);
      if (!keys.length) return { data: null, error: { message: 'empty update' } };
      const sets = keys.map((k, i) => {
        params.push(
          typeof this._payload[k] === 'object' && this._payload[k] !== null
            ? JSON.stringify(this._payload[k])
            : this._payload[k]
        );
        return `"${k}" = $${params.length}`;
      });
      let sql = `update "${this.table}" set ${sets.join(', ')}, updated_at = now()`;
      sql += this._where(params);
      sql += ' returning *';
      const { rows } = await pool.query(sql, params);
      if (this._single || this._maybe) return { data: rows[0] || null, error: null };
      return { data: rows, error: null };
    }

    if (this._op === 'delete') {
      let sql = `delete from "${this.table}"`;
      sql += this._where(params);
      sql += ' returning *';
      const { rows } = await pool.query(sql, params);
      return { data: rows, error: null };
    }

    if (this._op === 'upsert') {
      const rowsIn = Array.isArray(this._payload) ? this._payload : [this._payload];
      const out = [];
      for (const row of rowsIn) {
        if (row.id) {
          const exists = await pool.query(`select id from "${this.table}" where id = $1`, [row.id]);
          if (exists.rows[0]) {
            const keys = Object.keys(row).filter((k) => k !== 'id' && row[k] !== undefined);
            const sets = keys.map((k, i) => `"${k}" = $${i + 2}`).join(', ');
            const vals = keys.map((k) =>
              typeof row[k] === 'object' && row[k] !== null ? JSON.stringify(row[k]) : row[k]
            );
            const { rows } = await pool.query(
              `update "${this.table}" set ${sets}, updated_at = now() where id = $1 returning *`,
              [row.id, ...vals]
            );
            out.push(rows[0]);
            continue;
          }
        }
        const keys = Object.keys(row).filter((k) => row[k] !== undefined);
        const cols = keys.map((k) => `"${k}"`).join(', ');
        const ph = keys.map((_, i) => `$${i + 1}`).join(', ');
        const vals = keys.map((k) =>
          typeof row[k] === 'object' && row[k] !== null ? JSON.stringify(row[k]) : row[k]
        );
        const { rows } = await pool.query(
          `insert into "${this.table}" (${cols}) values (${ph}) returning *`,
          vals
        );
        out.push(rows[0]);
      }
      return { data: Array.isArray(this._payload) ? out : out[0], error: null };
    }

    return { data: null, error: { message: 'unknown op' } };
  }
}

export function createLocalAdmin() {
  return {
    from(table) {
      return new Query(table);
    },
    async rpc(name, args) {
      if (name === 'finalize_sale') {
        try {
          const { rows } = await pool.query(
            `select public.finalize_sale($1::jsonb, $2::jsonb, $3, $4) as result`,
            [
              JSON.stringify(args.p_items),
              JSON.stringify(args.p_sale),
              args.p_session_id,
              args.p_allow_zero_stock,
            ]
          );
          return { data: rows[0]?.result, error: null };
        } catch (e) {
          return { data: null, error: { message: e.message } };
        }
      }
      return { data: null, error: { message: `rpc ${name} not implemented locally` } };
    },
    storage: {
      from() {
        return {
          async upload() {
            return { error: { message: 'storage: use filesystem or Supabase in production' } };
          },
          getPublicUrl(path) {
            return { data: { publicUrl: `/uploads/${path}` } };
          },
        };
      },
    },
    auth: {
      async getUser() {
        return { data: { user: null }, error: { message: 'use local jwt' } };
      },
    },
  };
}
