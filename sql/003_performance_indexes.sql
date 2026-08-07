-- Darocha PDV — índices para multi-tenant e listagens
-- Rode no SQL Editor do Supabase (produção). Idempotente.

CREATE INDEX IF NOT EXISTS idx_product_created_by_updated
  ON product (created_by, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_product_created_by_active
  ON product (created_by, active)
  WHERE active IS DISTINCT FROM false;

CREATE INDEX IF NOT EXISTS idx_sale_created_by_created
  ON sale (created_by, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sale_created_by_status
  ON sale (created_by, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cash_session_created_by_status
  ON cash_session (created_by, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_customer_created_by_name
  ON customer (created_by, name);

CREATE INDEX IF NOT EXISTS idx_seller_created_by_status
  ON seller (created_by, status);

CREATE INDEX IF NOT EXISTS idx_app_settings_created_by
  ON app_settings (created_by, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_delivery_fee_created_by_active
  ON delivery_fee (created_by, active);

CREATE INDEX IF NOT EXISTS idx_financial_created_by_created
  ON financial_transaction (created_by, created_at DESC);

-- Acelera resolve de slug do catálogo (operational_log)
CREATE INDEX IF NOT EXISTS idx_operational_log_type_created
  ON operational_log (type, created_at DESC);
