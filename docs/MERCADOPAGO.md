# Mercado Pago — Catálogo Darocha (multi-lojista)

## Visão
Cada lojista conecta **a própria conta** Mercado Pago via OAuth.  
Pagamentos do catálogo (Pix / cartão) vão direto para essa conta.

## Variáveis de ambiente (backend)
```
MP_CLIENT_ID=          # Application ID da app Darocha no Mercado Pago
MP_CLIENT_SECRET=      # Secret da app
MP_REDIRECT_URI=https://api.darochapdv.com/functions/mercadopago-oauth-callback
MP_TOKEN_ENCRYPTION_KEY=  # string longa aleatória para AES-256-GCM
MP_PUBLIC_KEY=         # public key da app (opcional, cartão)
MP_WEBHOOK_URL=https://api.darochapdv.com/functions/mercadopago-webhook
API_PUBLIC_URL=https://api.darochapdv.com
FRONTEND_URL=https://darochapdv.com
```

## App no Mercado Pago
1. Crie uma aplicação em https://www.mercadopago.com.br/developers
2. Ative OAuth / marketplace (sellers conectam a conta)
3. Redirect URI = `MP_REDIRECT_URI`
4. Webhook URL = `MP_WEBHOOK_URL` (tópico `payment`)

## Lojista
Configurações → card **Mercado Pago** → **Conectar Mercado Pago**

## Fluxo catálogo
1. Cliente finaliza pedido com Pix ou Crédito
2. Backend cria sale `pending_payment` (sem baixar estoque)
3. Pix: gera QR + copia-e-cola; frontend faz polling + webhook confirma
4. Cartão: token MP → `catalog-checkout-card`
5. Aprovado → baixa estoque + notificação na loja

## Rotas
- POST `/functions/mercadopago-connect`
- GET  `/functions/mercadopago-oauth-callback`
- POST `/functions/mercadopago-status`
- POST `/functions/mercadopago-disconnect`
- POST `/functions/catalog-checkout-pix`
- POST `/functions/catalog-checkout-card`
- POST `/functions/catalog-checkout-status`
- POST `/functions/mercadopago-webhook`
