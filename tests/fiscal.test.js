import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mapPaymentCode,
  saleTotalsMatch,
  explainSefaz,
  onlyDigits,
  encryptSecret,
  decryptSecret,
} from '../src/fiscal_helpers.js';

test('mapeia formas de pagamento do PDV', () => {
  assert.equal(mapPaymentCode('Dinheiro').tPag, '01');
  assert.equal(mapPaymentCode('Pix').tPag, '17');
  assert.equal(mapPaymentCode('Débito').tPag, '04');
  assert.equal(mapPaymentCode('Crédito').tPag, '03');
});

test('totais da venda batem com a nota', () => {
  const sale = {
    items: [{ qty: 2, sale_price: 10, discount: 0 }],
    freight: 5,
    discount: 2,
    total: 23,
  };
  const r = saleTotalsMatch(sale);
  assert.equal(r.ok, true);
  assert.equal(r.computed, 23);
});

test('rejeita total divergente', () => {
  const r = saleTotalsMatch({ items: [{ qty: 1, sale_price: 10 }], total: 50 });
  assert.equal(r.ok, false);
});

test('explica rejeição SEFAZ 539', () => {
  const e = explainSefaz('539', 'Duplicidade de NF-e');
  assert.equal(e.code, '539');
  assert.match(e.text, /539/);
  assert.ok(e.action);
});

test('somente dígitos em CNPJ/CPF', () => {
  assert.equal(onlyDigits('12.345.678/0001-99'), '12345678000199');
});

test('criptografa e descriptografa segredo', () => {
  const enc = encryptSecret('senha-certificado');
  assert.ok(enc.includes('.'));
  assert.notEqual(enc, 'senha-certificado');
  assert.equal(decryptSecret(enc), 'senha-certificado');
});
