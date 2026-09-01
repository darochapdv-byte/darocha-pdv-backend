import assert from 'node:assert/strict';
import test from 'node:test';
import { encryptSecret, decryptSecret } from '../src/fiscal_helpers.js';

test('chave da loja não fica em texto puro', () => {
  const enc = encryptSecret('sk-loja-secreta-1234');
  assert.notEqual(enc, 'sk-loja-secreta-1234');
  assert.equal(decryptSecret(enc), 'sk-loja-secreta-1234');
});
