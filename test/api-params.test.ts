import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  decodeMarketId,
  encodeMarketId,
  InvalidParameterError,
  MAX_LIMIT,
  MAX_OFFSET,
  parseHistoryParams,
  parseMarketListParams,
} from '../src/api/params.ts';

const params = (query: string) => new URLSearchParams(query);

function rejects(fn: () => unknown, parameter: string) {
  assert.throws(fn, (error: unknown) => error instanceof InvalidParameterError && error.parameter === parameter);
}

describe('parseMarketListParams', () => {
  it('applies defaults', () => {
    assert.deepEqual(parseMarketListParams(params('league=Mirage')), {
      realm: 'pc',
      league: 'Mirage',
      quote: 'chaos',
      window: 1,
      scope: 'eligible',
      sort: 'rank',
      order: 'asc',
      q: undefined,
      limit: 50,
      offset: 0,
    });
  });

  it('sorts metrics largest first unless an order is given', () => {
    assert.equal(parseMarketListParams(params('league=M&sort=turnover')).order, 'desc');
    assert.equal(parseMarketListParams(params('league=M&sort=name')).order, 'asc');
    assert.equal(parseMarketListParams(params('league=M&sort=volatility&order=asc')).order, 'asc');
  });

  it('accepts the three metric windows only', () => {
    assert.equal(parseMarketListParams(params('league=M&window=6h')).window, 6);
    rejects(() => parseMarketListParams(params('league=M&window=2h')), 'window');
    rejects(() => parseMarketListParams(params('league=M&window=7d')), 'window');
  });

  it('bounds pagination', () => {
    assert.equal(parseMarketListParams(params(`league=M&limit=${MAX_LIMIT}&offset=${MAX_OFFSET}`)).limit, MAX_LIMIT);
    for (const bad of ['limit=0', `limit=${MAX_LIMIT + 1}`, 'limit=-1', 'limit=1.5', 'limit=abc', `offset=${MAX_OFFSET + 1}`]) {
      rejects(() => parseMarketListParams(params(`league=M&${bad}`)), bad.split('=')[0]!);
    }
  });

  it('requires a league and rejects other realms and quotes', () => {
    rejects(() => parseMarketListParams(params('')), 'league');
    rejects(() => parseMarketListParams(params('league=')), 'league');
    rejects(() => parseMarketListParams(params('league=M&realm=xbox')), 'realm');
    assert.equal(parseMarketListParams(params('league=M&quote=divine')).quote, 'divine');
    rejects(() => parseMarketListParams(params('league=M&quote=exalted')), 'quote');
  });

  it('rejects unknown, repeated and oversized parameters', () => {
    rejects(() => parseMarketListParams(params('leauge=M')), 'leauge');
    rejects(() => parseMarketListParams(params('league=M&league=N')), 'league');
    rejects(() => parseMarketListParams(params(`league=M&q=${'x'.repeat(201)}`)), 'q');
  });
});

describe('parseHistoryParams', () => {
  it('maps windows to hours and rejects others', () => {
    assert.equal(parseHistoryParams(params('league=M')).windowHours, 24);
    assert.equal(parseHistoryParams(params('league=M&window=7d')).windowHours, 168);
    assert.equal(parseHistoryParams(params('league=M&window=30d')).windowHours, 720);
    rejects(() => parseHistoryParams(params('league=M&window=90d')), 'window');
    rejects(() => parseHistoryParams(params('league=M&limit=5')), 'limit');
  });
});

describe('market ids', () => {
  const divine = 'Metadata/Items/Currency/CurrencyModValues';

  it('round-trips a Metadata path through a URL-safe id', () => {
    const id = encodeMarketId(divine);
    assert.match(id, /^[A-Za-z0-9_-]+$/);
    assert.equal(decodeMarketId(id), divine);
  });

  it('refuses ids that could not come from us', () => {
    assert.equal(decodeMarketId('xyz'), undefined);
    assert.equal(decodeMarketId(encodeMarketId('Something/Else')), undefined);
    assert.equal(decodeMarketId(`${encodeMarketId(divine)}=`), undefined, 'padding is not canonical');
    assert.equal(decodeMarketId('a/b'), undefined);
    assert.equal(decodeMarketId('A'.repeat(401)), undefined);
  });
});
