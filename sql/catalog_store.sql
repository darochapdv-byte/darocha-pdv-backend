-- Mapeamento estável de slug do catálogo por loja (todas as contas).
-- Ainda não aplicado no Supabase: o runtime usa operational_log type=catalog_slug.
-- Aplicar no SQL Editor quando puder.

create table if not exists public.catalog_store (
  user_id uuid primary key,
  slug text not null,
  aliases text[] not null default '{}',
  updated_at timestamptz not null default now()
);

create unique index if not exists catalog_store_slug_uidx on public.catalog_store (slug);
create index if not exists catalog_store_aliases_gin on public.catalog_store using gin (aliases);
