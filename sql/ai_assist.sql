-- Atendimento IA por loja (WhatsApp / Instagram / OpenAI / Gemini)
-- Aplicar no SQL Editor do Supabase. O backend também usa operational_log como fallback.

create table if not exists public.ai_conversation (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null,
  channel text not null,
  customer_id text not null,
  customer_name text,
  status text not null default 'ai',
  last_message text,
  last_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index if not exists ai_conversation_uidx
  on public.ai_conversation (created_by, channel, customer_id);

create table if not exists public.ai_message (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null,
  conversation_id uuid,
  channel text,
  customer_id text,
  role text not null,
  body text,
  provider text,
  model text,
  tokens integer,
  created_at timestamptz not null default now()
);

create index if not exists ai_message_conv_idx
  on public.ai_message (created_by, conversation_id, created_at);
