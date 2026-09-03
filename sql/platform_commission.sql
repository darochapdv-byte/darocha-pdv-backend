-- Comissão Darocha 1% + conta Stone por loja
create table if not exists public.platform_commission (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null,
  sale_id uuid not null,
  provider text not null default 'unknown',
  origin text,
  payment_method text,
  external_id text,
  gross_cents integer not null default 0,
  rate numeric not null default 0.01,
  fee_cents integer not null default 0,
  merchant_cents integer not null default 0,
  status text not null default 'pending',
  split_applied boolean not null default false,
  split_error text,
  refunded_cents integer not null default 0,
  meta jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create unique index if not exists platform_commission_sale_provider_uidx
  on public.platform_commission (sale_id, provider);
create index if not exists platform_commission_store_idx
  on public.platform_commission (store_id, created_at desc);

create table if not exists public.stone_account (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null unique,
  secret_encrypted text,
  recipient_id text,
  terminal_serial text,
  status text default 'disconnected',
  last_error text,
  split_enabled boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.platform_commission enable row level security;
alter table public.stone_account enable row level security;
