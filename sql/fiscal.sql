-- Documentos fiscais eletrônicos (NFC-e 65 / NF-e 55)
-- Aplicar no SQL Editor do Supabase. O backend também grava fallback em operational_log.

create table if not exists public.fiscal_document (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null,
  sale_id text,
  document_type text not null default 'nfce',
  model text not null default '65',
  series text,
  number text,
  access_key text,
  status text not null default 'aguardando',
  environment text not null default 'homologacao',
  protocol text,
  authorization_date timestamptz,
  cancellation_date timestamptz,
  cancel_reason text,
  cancelled_by uuid,
  xml text,
  danfe_url text,
  qrcode_url text,
  provider text default 'nuvemfiscal',
  provider_document_id text,
  provider_status text,
  rejection_code text,
  rejection_message text,
  rejection_hint text,
  idempotency_key text,
  total numeric,
  customer_doc text,
  customer_name text,
  payment_summary jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists fiscal_document_idem_uidx
  on public.fiscal_document (created_by, idempotency_key)
  where idempotency_key is not null;

create index if not exists fiscal_document_sale_idx
  on public.fiscal_document (created_by, sale_id);

create index if not exists fiscal_document_status_idx
  on public.fiscal_document (created_by, status, created_at desc);

create index if not exists fiscal_document_key_idx
  on public.fiscal_document (access_key);

alter table public.fiscal_document enable row level security;
