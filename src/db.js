/**
 * Dual backend:
 * - DATABASE_URL → Postgres local (pg)
 * - SUPABASE_URL + keys → Supabase
 */
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { createLocalAdmin } from './localStore.js';

const { Pool } = pg;

export const useLocal = !!process.env.DATABASE_URL && !process.env.SUPABASE_URL;

export const pool = useLocal
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : null;

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;

export const admin = useLocal
  ? createLocalAdmin()
  : (url && serviceKey
      ? createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
      : null);

export function userClient(accessToken) {
  if (useLocal || !url || !anonKey) return null;
  return createClient(url, anonKey, {
    global: { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {} },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export const ENTITY_TABLE = {
  AppSettings: 'app_settings',
  BarcodeKnowledge: 'barcode_knowledge',
  CashClosing: 'cash_closing',
  CashMovement: 'cash_movement',
  CashSession: 'cash_session',
  Commission: 'commission',
  Courier: 'courier',
  CourierClosing: 'courier_closing',
  Customer: 'customer',
  DeliveryFee: 'delivery_fee',
  ExpenseCategory: 'expense_category',
  FinancialTransaction: 'financial_transaction',
  FixedExpense: 'fixed_expense',
  HelpArticle: 'help_article',
  NFeImport: 'nfe_import',
  Notification: 'notification',
  OperationalLog: 'operational_log',
  Payroll: 'payroll',
  PinAccessLog: 'pin_access_log',
  ProblemReport: 'problem_report',
  Product: 'product',
  Referral: 'referral',
  Reward: 'reward',
  Sale: 'sale',
  SaleAuditLog: 'sale_audit_log',
  SaleReturn: 'sale_return',
  Seller: 'seller',
  StockCount: 'stock_count',
  StockCountAuditLog: 'stock_count_audit_log',
  StockCountItem: 'stock_count_item',
  StockEntry: 'stock_entry',
  StockEntryAuditLog: 'stock_entry_audit_log',
  StockReservation: 'stock_reservation',
  Subscription: 'subscription',
  SubscriptionLog: 'subscription_log',
  Supplier: 'supplier',
  WishlistItem: 'wishlist_item',
};

export function tableFor(entityName) {
  return ENTITY_TABLE[entityName] || entityName
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/** Query helper local */
export async function query(text, params = []) {
  if (!pool) throw new Error('no_local_pool');
  return pool.query(text, params);
}
