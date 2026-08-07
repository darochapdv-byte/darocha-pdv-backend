# Segurança — checklist operacional

## Rotação obrigatória (faça agora no painel de cada serviço)
- [ ] Vercel token (Settings → Tokens)
- [ ] Render API key
- [ ] GitHub PAT do repositório backend
- [ ] Senhas das contas de teste e produção
- [ ] JWT_SECRET / chaves Supabase service role (se vazaram)

## Multi-tenant
- Listagens de negócio **exigem** usuário autenticado.
- Filtro `created_by = user.id` nas entidades de tenant.
- Catálogo público **exige** `loja`/slug.
- Backend usa service role: RLS no Postgres ainda é recomendado (ver `sql/004_rls_checklist.sql`).

## CORS
- Origens restritas a `*.darochapdv.com`, Vercel do projeto e localhost.

## Headers
- `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`.
