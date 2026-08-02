# Estabilidade — Darocha PDV

## Checklist diário (1 minuto)
- [ ] App abre no celular e no computador
- [ ] Login funciona (e-mail/senha)
- [ ] Caixa abre ou já está aberto
- [ ] Dá para fazer uma venda simples

## Checklist semanal (5 minutos)
- [ ] Cadastro de produto **com foto**
- [ ] Produto aparece no **catálogo** com a foto
- [ ] Pedido pelo catálogo → aparece no **sininho**
- [ ] Impressão da **notinha**
- [ ] Configuração “Vender sem estoque” (se usar) salva ok
- [ ] `/health` responde ok: https://darocha-pdv-backend.onrender.com/health

## O que já está no modo gratuito (feito no código)
1. Health check testa conexão com o banco (não só “servidor ligado”)
2. SPA no frontend (atualizar `/catalogo` não dá 404)
3. Upload de foto via API REST do Storage (menos erro de RLS)
4. Política global de estoque e filtros de listagem corrigidos
5. Documentação de deploy e checklists

## Grátis: manter o backend “acordado” (cold start)

No plano **free** do Render, após ~15 min parado o servidor dorme e a 1ª abertura demora ~30s.

**Mitigação gratuita:** um monitor pingando o health a cada 5–10 minutos.

### UptimeRobot (grátis)
1. Crie conta em https://uptimerobot.com
2. Add New Monitor
3. Type: **HTTP(s)**
4. URL: `https://darocha-pdv-backend.onrender.com/health`
5. Interval: **5 minutes**
6. Create

Isso não substitui o plano pago, mas reduz muito o “app demorou para abrir”.

## Pago: Render Starter (quando for a hora)

Objetivo: acabar de vez com o cold start.

### Passo a passo
1. Entre em https://dashboard.render.com
2. Faça login na conta do backend
3. Abra o serviço **darocha-pdv-backend**
4. Clique em **Settings** (ou no plano atual)
5. **Change plan** / **Instance type** → **Starter** (cerca de US$ 7/mês)
6. Confirme o pagamento (cartão)
7. Aguarde o serviço reiniciar (1–3 min)
8. Teste: abra o app, espere 20 min sem usar, abra de novo — deve continuar rápido

### Depois de pagar, você pode
- Remover o UptimeRobot se quiser (não é mais necessário para cold start)
- Manter o checklist semanal

## Segurança (grátis, importante)
Tokens e senhas que já apareceram em conversas/documentos devem ser **trocados**:
- GitHub Personal Access Token
- Render API Key
- Vercel Token
- Idealmente: JWT_SECRET no Render (usuários precisarão logar de novo)

Como trocar (resumo):
1. Gere um token novo no site do serviço
2. Atualize no painel (Render env vars, etc.)
3. Revogue o token antigo
4. Não envie o token novo por WhatsApp/e-mail aberto

## Backup de dados (grátis)
No Supabase → Table Editor / SQL:
- Export CSV das tabelas principais: `product`, `customer`, `sale`, `seller`
- Ou use Backup no plano que oferecer snapshot

Frequência sugerida: **1x por semana**.

## Quando chamar ajuda
- Tela branca depois de um deploy
- `/health` com `"ok": false` ou status 503
- Upload de foto falhando de novo
- Pedido do catálogo não aparece no sininho
