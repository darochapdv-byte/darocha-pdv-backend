-- Opcional: tabelas dedicadas (o código também usa app_settings.mercadopago)
create table if not exists payment_account (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  provider text not null default 'mercadopago',
  provider_user_id text,
  access_token_encrypted text,
  refresh_token_encrypted text,
  public_key text,
  token_expires_at timestamptz,
  status text default 'disconnected',
  nickname text,
  email text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(user_id, provider)
);

create table if not exists payment_transaction (
  id uuid primary key default gen_random_uuid(),
  order_id uuid,
  payment_account_id uuid,
  provider text default 'mercadopago',
  provider_payment_id text,
  provider_order_id text,
  payment_method text,
  status text,
  amount numeric,
  installments int,
  external_reference text,
  qr_code text,
  qr_code_base64 text,
  expires_at timestamptz,
  raw_response jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_payment_tx_order on payment_transaction(order_id);
create index if not exists idx_payment_tx_provider on payment_transaction(provider_payment_id);

-- colunas auxiliares em sale (ignore se já existirem)
alter table sale add column if not exists payment_status text;
alter table sale add column if not exists mp_payment_id text;
alter table sale add column if not exists payment_meta jsonb;
alter table sale add column if not exists paid_at timestamptz;

-- JSONB na app_settings
alter table app_settings add column if not exists mercadopago jsonb;
