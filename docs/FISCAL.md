# Módulo fiscal NFC-e / NF-e

Provedor: **Nuvem Fiscal** (multi-CNPJ, homologação e produção).
O certificado A1 e tokens nunca vão para o frontend.

## Render — variáveis

```
FISCAL_PROVIDER=nuvemfiscal
FISCAL_API_URL=https://api.nuvemfiscal.com.br
FISCAL_API_TOKEN=          # token da conta Darocha no painel Nuvem Fiscal
FISCAL_ENCRYPTION_KEY=     # 32+ chars, AES dos CSC/tokens da loja
FISCAL_WEBHOOK_SECRET=     # opcional, validação do webhook
```

Webhook: `https://darocha-pdv-backend.onrender.com/functions/fiscal-webhook`

## Supabase

Rodar `sql/fiscal.sql` no SQL Editor (tabela `fiscal_document`).
Enquanto a tabela não existir, o backend grava em `operational_log` (`type=fiscal_document`).
Configuração da loja fica em `app_settings.role_payment_methods.__darocha_fiscal`.

## Nuvem Fiscal

1. Criar conta em https://nuvemfiscal.com.br
2. Gerar token de API e colar em `FISCAL_API_TOKEN`
3. Cadastrar webhook apontando para a URL acima
4. Cada loja envia o próprio A1 pela tela Configurações → Fiscal

## Homologação

Ambiente padrão: homologação. Notas sem valor fiscal.
Produto precisa de NCM e CFOP. Empresa: CNPJ, IE, endereço, certificado.

## Produção

Só depois do teste autorizado em homologação.
Contador informa: CSC/ID token da NFC-e da UF, série, numeração, regime, NCM/CFOP.
