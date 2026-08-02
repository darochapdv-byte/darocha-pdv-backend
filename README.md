# Darocha PDV — Backend

API do PDV (Node.js + Hono + Supabase).

## Stack
- Node.js + Hono
- Supabase (Postgres + Auth + Storage)
- Deploy: Render.com

## Desenvolvimento local
```bash
cp .env.example .env
# preencha SUPABASE_* ou DATABASE_URL
npm install
npm run dev
```

Health: `GET http://localhost:8787/health`

## Produção (Render)
- Build: `npm install`
- Start: `node src/index.js`
- Health check path: `/health`

### Variáveis obrigatórias (Render)
- `NODE_ENV=production`
- `PORT=8787` (ou a que o Render definir)
- `JWT_SECRET`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

## Deploy
Push na branch `master` ou trigger manual na API do Render.

## Documentação de estabilidade
Veja [STABILITY.md](./STABILITY.md).
