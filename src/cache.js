/**
 * Cache em memória com TTL — acelera auth e listagens quentes.
 * Process-local (cada instância Render tem o seu). Suficiente para latência.
 */

const store = new Map();

export function cacheGet(key) {
  const item = store.get(key);
  if (!item) return undefined;
  if (Date.now() > item.expires) {
    store.delete(key);
    return undefined;
  }
  return item.value;
}

export function cacheSet(key, value, ttlMs = 45000) {
  store.set(key, { value, expires: Date.now() + Math.max(1000, ttlMs) });
  // Limpeza ocasional para não crescer sem limite
  if (store.size > 500) {
    const now = Date.now();
    for (const [k, v] of store) {
      if (now > v.expires) store.delete(k);
    }
  }
}

export function cacheDel(key) {
  store.delete(key);
}

export function cacheDelPrefix(prefix) {
  for (const k of store.keys()) {
    if (k.startsWith(prefix)) store.delete(k);
  }
}

/** Hash simples do token para chave (não guarda o token inteiro) */
export function tokenKey(token) {
  if (!token) return 'tok:none';
  // primeiros + últimos chars bastam para unicidade prática
  const t = String(token);
  return `tok:${t.slice(0, 16)}:${t.slice(-12)}:${t.length}`;
}
