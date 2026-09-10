import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ApiFailure, CLIENT_ERROR_CODES } from '../api/errors';
import { FixtureGatewayClient, createFixtureClient } from './fixture-client';
import { FIXTURE_RESPONSES } from './fixtures';
import {
  DEMO_DATA_MODES,
  DEMO_IDENTITY,
  FIXTURE_DISCLOSURE,
  FIXTURE_MODE_VALUE,
  isFixtureMode,
  readDemoDataMode,
} from './mode';

/**
 * The rules that make a fixture demo honest rather than a forgery.
 *
 * Three of them, and each has a way of eroding quietly:
 *
 *  1. Fixture mode is **chosen**, never fallen back into. The convenient bug is
 *     a `catch` that swaps in fixtures when the gateway is down, which would
 *     leave a presenter demonstrating a dead backend to an audience with no
 *     indication on screen — and, worse, no indication to the presenter.
 *  2. A fixture session **cannot reach the network**, in either direction: it
 *     has no `fetch` to read with, no token to authenticate with, and refuses
 *     every method but `GET` before it even looks a route up.
 *  3. Nothing in the dataset **imitates a credential**. The records are
 *     deliberately coherent, which is exactly what makes a stray token-shaped
 *     string in them dangerous.
 *
 * The structural assertions below read source files rather than behaviour.
 * That is deliberate for the fallback rule in particular: a behavioural test
 * can only prove that the paths it happened to exercise did not fall back,
 * while grepping for the import proves that no path can.
 */

const SRC = path.join(__dirname, '..', '..');

function read(relative: string): string {
  return readFileSync(path.join(SRC, relative), 'utf8');
}

describe('choosing the data mode', () => {
  it('offers exactly two modes', () => {
    expect([...DEMO_DATA_MODES]).toEqual(['live', 'fixture']);
  });

  it('turns fixtures on for the exact literal and nothing else', () => {
    expect(readDemoDataMode(FIXTURE_MODE_VALUE)).toBe('fixture');
    // Whitespace from a shell or an `.env` line is not a different intent.
    expect(readDemoDataMode('  fixture  ')).toBe('fixture');
  });

  /**
   * Every one of these is a plausible way somebody could try to enable the
   * mode, and every one of them must fail closed. A truthiness check would
   * accept the lot, and `NEXT_PUBLIC_DEMO_DATA_MODE=false` would enable
   * fixtures — which is the kind of defect that is only discovered on stage.
   */
  it.each(['1', 'true', 'yes', 'on', 'FIXTURE', 'Fixture', 'fixtures', 'demo', 'false', '', ' '])(
    'stays live for %p',
    (raw) => {
      expect(readDemoDataMode(raw)).toBe('live');
    },
  );

  it('stays live when nothing is configured', () => {
    expect(readDemoDataMode(undefined)).toBe('live');
  });

  it('recognises only the fixture mode as a fixture mode', () => {
    expect(isFixtureMode('fixture')).toBe(true);
    expect(isFixtureMode('live')).toBe(false);
  });
});

describe('fixture mode is never a fallback', () => {
  /**
   * The load-bearing test in this file.
   *
   * `createFixtureClient` is the only door into the dataset. If the only module
   * that opens it is the one that reads configuration at session start, then no
   * error handler, retry, adapter or screen is *able* to reach fixtures —
   * regardless of what any of them do when a request fails.
   */
  it('is reachable from exactly one module, and that module is the mode switch', () => {
    const callers = sourceFiles().filter(
      (file) => !file.endsWith('.spec.ts') && !file.endsWith('.spec.tsx'),
    );

    const importers = callers.filter((file) => {
      if (file.endsWith(path.join('lib', 'demo', 'fixture-client.ts'))) return false;
      return /createFixtureClient|from '\.\/fixtures'|demo\/fixtures/.test(
        readFileSync(file, 'utf8'),
      );
    });

    expect(importers.map((file) => path.relative(SRC, file).replaceAll('\\', '/'))).toEqual([
      'lib/auth/session.tsx',
    ]);
  });

  /**
   * And the one place that does open it, opens it before anything can fail.
   *
   * The fixture branch returns before the OIDC path is constructed, so there is
   * no request in flight at the point the decision is made — which is what makes
   * "the mode is decided once, from configuration" a fact about the code rather
   * than an intention in a comment.
   */
  it('decides from configuration, not from a failed request', () => {
    const session = read('lib/auth/session.tsx');

    const decision = session.indexOf('isFixtureMode(dataMode)');
    expect(decision).toBeGreaterThan(-1);

    // No error-handling construct sits between the mode check and the fixture
    // client being built.
    const branch = session.slice(decision, session.indexOf('createFixtureClient'));
    expect(branch).not.toMatch(/catch|onError|\.status\b|failure/i);
  });

  it('never mentions fixtures in the error module', () => {
    // `errors.ts` names the two fixture error codes, which is not the same as
    // reaching for fixture data — assert it holds no import of the dataset.
    expect(read('lib/api/errors.ts')).not.toMatch(/from '.*fixtures?'/);
  });
});

describe('the fixture client cannot reach a backend', () => {
  const client = new FixtureGatewayClient(FIXTURE_RESPONSES);
  const anySchema = z.unknown();

  it('holds no network primitive and no credential', () => {
    const source = read('lib/demo/fixture-client.ts');
    const code = source.replaceAll(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

    for (const forbidden of ['fetch', 'XMLHttpRequest', 'WebSocket', 'Authorization', 'token']) {
      expect(code).not.toContain(forbidden);
    }
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('refuses %s', async (method) => {
    // A path that *does* exist in the dataset, so the refusal is proven to come
    // from the method rather than from a missing fixture.
    const attempt = client.request({
      method: method as 'POST',
      path: '/v1/assets',
      schema: anySchema,
    });

    await expect(attempt).rejects.toBeInstanceOf(ApiFailure);
    await expect(attempt).rejects.toMatchObject({
      code: CLIENT_ERROR_CODES.FIXTURE_WRITE_REFUSED,
    });
  });

  it('refuses a write before looking the route up', async () => {
    // An unknown path would produce FIXTURE_MISSING if the lookup ran first.
    // The write refusal has to win, or the message would misdescribe what
    // happened and hide the fact that a mutation was attempted at all.
    await expect(
      client.request({ method: 'POST', path: '/v1/nothing-here', schema: anySchema }),
    ).rejects.toMatchObject({ code: CLIENT_ERROR_CODES.FIXTURE_WRITE_REFUSED });
  });

  it('answers a GET the dataset covers', async () => {
    const result = await client.request({ path: '/v1/assets', schema: anySchema });
    expect(result.status).toBe(200);
  });

  it('reports an uncovered route as a gap in the demo, not as an empty result', async () => {
    // `NOT_FOUND` here would be indistinguishable from the service legitimately
    // having no such record, and a presenter would debug the wrong thing.
    await expect(
      client.request({ path: '/v1/not-in-the-dataset', schema: anySchema }),
    ).rejects.toMatchObject({ code: CLIENT_ERROR_CODES.FIXTURE_MISSING });
  });

  it('rejects a fixture that has drifted from the contract', async () => {
    const drifted = new FixtureGatewayClient({ '/v1/assets': { unexpected: true } });

    await expect(
      drifted.request({ path: '/v1/assets', schema: z.object({ items: z.array(z.unknown()) }) }),
    ).rejects.toMatchObject({ code: CLIENT_ERROR_CODES.MALFORMED_RESPONSE });
  });

  it('mints correlation ids nobody could mistake for real ones', async () => {
    const first = await client.request({ path: '/v1/assets', schema: anySchema });
    const second = await client.request({ path: '/v1/organizations', schema: anySchema });

    // A real one is a ULID the gateway minted and every service logged against.
    // Handing a presenter something that looked like one would invite them to
    // quote it to support for a request that never existed.
    expect(first.correlationId).toMatch(/^fixture-\d{4}$/);
    expect(second.correlationId).not.toBe(first.correlationId);
  });

  it('builds through the async factory without a network call', async () => {
    const fetchSpy = jest.fn();
    const original = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      const built = await createFixtureClient();
      await built.request({ path: '/v1/assets', schema: anySchema });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('the simulated identity', () => {
  it('carries no credential of any kind', () => {
    const fields = Object.keys(DEMO_IDENTITY);

    for (const field of fields) {
      expect(field).not.toMatch(/token|secret|password|credential|jwt|bearer/i);
    }

    // Named explicitly as well, so adding one later fails here rather than
    // silently widening what a fixture session holds.
    expect(fields).toEqual([
      'subject',
      'userId',
      'displayName',
      'email',
      'roles',
      'organizationId',
      'organizationIds',
    ]);
  });

  it('announces itself as simulated in every identifying field', () => {
    expect(DEMO_IDENTITY.displayName).toContain('شبیه‌سازی‌شده');
    expect(DEMO_IDENTITY.subject).toContain('not-a-real-account');
    expect(DEMO_IDENTITY.userId).toContain('demo');
    // RFC 2606 reserves `.invalid` precisely so it can never resolve to anyone.
    expect(DEMO_IDENTITY.email.endsWith('.invalid')).toBe(true);
    for (const id of DEMO_IDENTITY.organizationIds) expect(id).toContain('demo');
  });

  it('stays off the production authentication path', () => {
    const session = read('lib/auth/session.tsx');
    const fixtureBranch = session.slice(
      session.indexOf('isFixtureMode(dataMode)'),
      session.indexOf('createFixtureClient'),
    );

    expect(fixtureBranch).not.toMatch(/oidc-client-ts|UserManager|signinRedirect/);
  });
});

describe('the dataset itself', () => {
  const serialized = JSON.stringify(FIXTURE_RESPONSES);

  it('imitates no credential, anywhere', () => {
    // The records are deliberately coherent, which is what makes a stray
    // token-shaped string in them worth failing a build over.
    expect(serialized).not.toMatch(/Bearer\s/i);
    // A JWT's three base64 segments.
    expect(serialized).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}\./);
    expect(serialized).not.toMatch(/"(access_?token|refresh_?token|password|client_?secret)"/i);
  });

  it('uses no address that could reach a real person', () => {
    const addresses = serialized.match(/[\w.+-]+@[\w.-]+/g) ?? [];
    for (const address of addresses) {
      expect(address).toMatch(/\.(invalid|example|test|localhost)$/);
    }
  });

  it('marks every record as demonstration data in its own identifier', () => {
    const ids = serialized.match(/"id":"([^"]+)"/g) ?? [];
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id).toContain('demo');
  });

  it('states the disclosure the banner shows in one place only', () => {
    expect(FIXTURE_DISCLOSURE).toContain('ساختگی');
    expect(FIXTURE_DISCLOSURE).toContain('از سرویس‌های واقعی خوانده نمی‌شوند');
  });
});

/** Every `.ts`/`.tsx` file under `src`, so a new module cannot dodge the scan. */
function sourceFiles(): string[] {
  const out: string[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
  };

  walk(SRC);
  return out.sort();
}
