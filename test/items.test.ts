import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { itemLabel } from '../src/items.ts';

describe('itemLabel', () => {
  it('uses the display name, or the last path segment when the name is unknown', () => {
    assert.equal(itemLabel('Metadata/Items/Currency/CurrencyRerollRare', 'Chaos Orb'), 'Chaos Orb');
    assert.equal(itemLabel('Metadata/Items/Currency/CurrencyBrandNew', null), 'CurrencyBrandNew');
    assert.equal(itemLabel('Metadata/Items/Currency/CurrencyBrandNew', ''), 'CurrencyBrandNew');
    assert.equal(itemLabel('NoSlashes', undefined), 'NoSlashes');
  });
});
