# Atendimento IA — WhatsApp + Instagram + OpenAI/Gemini

Cada loja usa **a própria** chave de API. O Darocha não paga o consumo.

## Render (só do sistema)

```
META_APP_ID=
META_APP_SECRET=
META_VERIFY_TOKEN=darocha-ai
FISCAL_ENCRYPTION_KEY=   # reutilizada para criptografar as chaves das lojas
```

Webhook da Meta: `https://darocha-pdv-backend.onrender.com/functions/ai-webhook`

**Não** crie `OPENAI_API_KEY` global.

## Supabase

Rode `sql/ai_assist.sql`.

## Lojista — OpenAI

1. https://platform.openai.com/api-keys  
2. Crie uma chave (precisa de faturamento na OpenAI — ChatGPT Plus **não** serve)  
3. PDV → Configurações → Sistema → Atendimento IA  
4. Provedor OpenAI, cole a chave, Testar conexão, Ativar  

## Lojista — Gemini

1. https://aistudio.google.com/apikey  
2. Gere a chave  
3. No PDV escolha Gemini, cole, teste, ative  

## WhatsApp / Instagram (Meta)

1. Crie um app em https://developers.facebook.com  
2. Produtos: WhatsApp Cloud API e/ou Instagram Messaging  
3. Webhook: URL acima, verify token `darocha-ai`  
4. No PDV informe Phone Number ID + token permanente do WhatsApp (ou IG user id + token)  
5. Não peça senha pessoal do WhatsApp/Instagram  

Limitações Meta: conta Business, janela de 24h no WhatsApp, Instagram profissional, app em revisão para produção.

## Testar

- Testar conexão (chama o provedor da loja)  
- Enviar mensagem de teste no canal conectado  
- Pedir “quero falar com uma pessoa” → modo humano (IA para)
