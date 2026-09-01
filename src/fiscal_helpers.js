import crypto from 'crypto';

function env(k) {
  return process.env[k] || '';
}

function encryptionKey() {
  const raw = env('FISCAL_ENCRYPTION_KEY') || env('MP_TOKEN_ENCRYPTION_KEY') || env('JWT_SECRET') || 'darocha-fiscal-dev-key';
  return crypto.createHash('sha256').update(String(raw)).digest();
}

export function encryptSecret(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

export function decryptSecret(payload) {
  if (!payload) return '';
  if (!String(payload).includes('.')) return String(payload);
  const [ivB64, tagB64, dataB64] = String(payload).split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

export function onlyDigits(v) {
  return String(v || '').replace(/\D/g, '');
}

export function mapPaymentCode(method) {
  const m = String(method || '').toLowerCase();
  if (m.includes('dinheiro') || m === 'cash' || m === 'money') return { tPag: '01', label: 'Dinheiro' };
  if (m.includes('pix')) return { tPag: '17', label: 'Pix' };
  if (m.includes('débito') || m.includes('debito') || m === 'debit') return { tPag: '04', label: 'Cartão de débito' };
  if (m.includes('crédito') || m.includes('credito') || m === 'credit' || m.includes('cart')) return { tPag: '03', label: 'Cartão de crédito' };
  if (m.includes('vale') || m.includes('ticket')) return { tPag: '99', label: 'Outros' };
  return { tPag: '99', label: 'Outros' };
}

export function saleTotalsMatch(sale) {
  const items = Array.isArray(sale?.items) ? sale.items : [];
  const itemsSum = items.reduce((acc, it) => {
    const q = Number(it.qty ?? it.quantity ?? 1) || 0;
    const p = Number(it.sale_price ?? it.unit_price ?? it.price ?? 0) || 0;
    const disc = Number(it.discount ?? it.item_discount ?? 0) || 0;
    return acc + q * p - disc;
  }, 0);
  const freight = Number(sale?.freight ?? sale?.shipping ?? sale?.delivery_fee ?? 0) || 0;
  const extra = Number(sale?.surcharge ?? sale?.acrescimo ?? sale?.fees ?? 0) || 0;
  const discount = Number(sale?.discount ?? sale?.discount_total ?? 0) || 0;
  const computed = Math.round((itemsSum + freight + extra - discount) * 100) / 100;
  const total = Math.round(Number(sale?.total ?? computed) * 100) / 100;
  return { ok: Math.abs(computed - total) < 0.02, computed, total };
}

export function explainSefaz(code, message) {
  const c = String(code || '').replace(/\D/g, '');
  const map = {
    '204': { cause: 'Duplicidade de NFC-e/NF-e.', action: 'Consulte o documento já autorizado. Não emita de novo a mesma venda.' },
    '539': { cause: 'Duplicidade de NF-e.', action: 'Use a nota já autorizada ou cancele antes de reenviar.' },
    '215': { cause: 'Falha no schema XML.', action: 'Revise NCM, CFOP, endereço e totais dos produtos.' },
    '225': { cause: 'Falha no Schema da NFe.', action: 'Confira campos obrigatórios da empresa e dos itens.' },
    '598': { cause: 'NFC-e com valor acima do limite sem destinatário.', action: 'Informe CPF/CNPJ do cliente nesta venda.' },
  };
  const known = map[c] || { cause: message || 'Rejeição da SEFAZ.', action: 'Corrija o apontado e tente emitir de novo, sem nova venda.' };
  return {
    code: c || null,
    message: message || 'Rejeição da SEFAZ.',
    cause: known.cause,
    action: known.action,
    text: c
      ? `Documento rejeitado. Código ${c}: ${message || known.cause}`
      : (message || 'Documento rejeitado pela SEFAZ.'),
  };
}
