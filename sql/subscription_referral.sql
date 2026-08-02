-- Assinatura + Indicação — rode no SQL Editor do Supabase

-- subscription
ALTER TABLE subscription ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz;
ALTER TABLE subscription ADD COLUMN IF NOT EXISTS is_lifetime boolean DEFAULT false;
ALTER TABLE subscription ADD COLUMN IF NOT EXISTS free_months_remaining int DEFAULT 0;
ALTER TABLE subscription ADD COLUMN IF NOT EXISTS discount_50 boolean DEFAULT false;
ALTER TABLE subscription ADD COLUMN IF NOT EXISTS months_paid int DEFAULT 0;
ALTER TABLE subscription ADD COLUMN IF NOT EXISTS stripe_customer_id text;
ALTER TABLE subscription ADD COLUMN IF NOT EXISTS stripe_subscription_id text;
ALTER TABLE subscription ADD COLUMN IF NOT EXISTS plan text;
ALTER TABLE subscription ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE subscription ADD COLUMN IF NOT EXISTS user_id uuid;

-- unique user_id se ainda não existir
DO $$ BEGIN
  ALTER TABLE subscription ADD CONSTRAINT subscription_user_id_key UNIQUE (user_id);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $$;

-- profiles referral
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS referral_code text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS referred_by_code text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS referred_by_user_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_referral_code_uidx
  ON profiles (referral_code) WHERE referral_code IS NOT NULL;

-- referral
CREATE TABLE IF NOT EXISTS referral (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_user_id uuid,
  referrer_code text,
  referred_user_id uuid,
  referred_email text,
  status text DEFAULT 'pending',
  months_subscribed int DEFAULT 0,
  longterm_granted boolean DEFAULT false,
  validated_at timestamptz,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE referral ADD COLUMN IF NOT EXISTS validated_at timestamptz;
ALTER TABLE referral ADD COLUMN IF NOT EXISTS months_subscribed int DEFAULT 0;
ALTER TABLE referral ADD COLUMN IF NOT EXISTS longterm_granted boolean DEFAULT false;

-- reward
CREATE TABLE IF NOT EXISTS reward (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  type text,
  amount numeric,
  reason text,
  referral_id uuid,
  referred_user_id uuid,
  created_at timestamptz DEFAULT now()
);

-- subscription_log
CREATE TABLE IF NOT EXISTS subscription_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  event text,
  details jsonb,
  created_at timestamptz DEFAULT now()
);

-- master code usage (darochadev)
CREATE TABLE IF NOT EXISTS master_code_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  user_id uuid,
  user_email text,
  used_at timestamptz DEFAULT now()
);
