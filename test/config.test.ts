import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { ConfigError, parseRealm } from '../src/config.ts';

describe('parseRealm', () => {
  it('accepts pc', () => {
    assert.equal(parseRealm('pc'), 'pc');
  });

  it('rejects console and unknown realms with a clear error', () => {
    for (const value of ['xbox', 'sony', 'PC', 'poe2', '']) {
      assert.throws(() => parseRealm(value), (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.equal(error.message, `Realm "${value}" is not supported; only PoE 1 PC ("pc") is collected`);
        return true;
      });
    }
  });
});

describe('fetch CLI', () => {
  const script = fileURLToPath(new URL('../src/cli/fetch.ts', import.meta.url));

  // The database URL points at a closed port, so reaching the database or the API would exit 1, not 2.
  function runFetch(args: string[], env: Record<string, string> = {}) {
    return spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none',
        POE_USER_AGENT_CONTACT: 'test',
        ...env,
      },
    });
  }

  it('rejects a non-PC --realm before connecting or fetching', () => {
    const result = runFetch(['--realm', 'xbox']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /invalid configuration.*Realm \\"xbox\\" is not supported/);
  });

  it('rejects a non-PC POE_REALM before connecting or fetching', () => {
    const result = runFetch([], { POE_REALM: 'sony' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Realm \\"sony\\" is not supported/);
  });
});
