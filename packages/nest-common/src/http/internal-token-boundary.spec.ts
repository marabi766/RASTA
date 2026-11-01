import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inspect } from 'node:util';
import { SignJWT } from 'jose';
import {
  InternalHttpClient,
  InternalTokenService,
  type InternalGrant,
} from './internal-http-client';

/**
 * The issuance boundary at run time (PR #503 r2, review F1/F2).
 *
 * Every snippet the review showed passing the lint rule is run here against
 * the real classes: none of them yields a token `verify` accepts. Only
 * `InternalHttpClient.authorize` mints, and the key it signs with is no
 * property of anything reachable from outside its module. The one way left to
 * a token — the transport a client is built with sees the header it sends —
 * is the documented residual, pinned by the last case so the doc stays true.
 */

const SECRET = 's'.repeat(40);
const ISSUER = 'rasta-internal';
const TARGET = 'economic-service';
const GRANT: InternalGrant = {
  from: 'contract-service',
  to: TARGET,
  purpose: 'SERVICE',
  organizationId: 'org-1',
};

/** A structural stand-in, as in the review's snippets. */
type Minter = {
  issue(caller: string, target: string, purpose?: string, org?: string): Promise<string>;
};

const NOT_CALLABLE = /InternalTokenService\.issue is not callable/;

/** The token a client built with `tokens` puts on the wire, read at its transport. */
async function minted(
  tokens: InternalTokenService,
  extra?: RequestInit['headers'],
): Promise<string[]> {
  const seen: string[] = [];
  const transport: typeof fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    seen.push(headers.get('x-internal-token') ?? '');
    return new Response(null, { status: 204 });
  };
  const sender = await new InternalHttpClient(tokens, transport).authorize(GRANT);
  await sender.send('http://economic.invalid/v1/internal/x', { method: 'GET', headers: extra });
  return seen;
}

describe('internal-token issuance boundary (run time)', () => {
  const tokens = new InternalTokenService(SECRET, ISSUER, 300);

  it('mints through the client, and the token verifies', async () => {
    const [token] = await minted(tokens);
    await expect(tokens.verify(token!, TARGET)).resolves.toMatchObject({
      callerService: 'contract-service',
      purpose: 'SERVICE',
      organizationId: 'org-1',
    });
  });

  describe('review F1: issue() refuses however it is reached', () => {
    const snippets: Array<[string, () => unknown]> = [
      ['direct call', () => tokens.issue('a', TARGET)],
      ['a container cast through unknown', () => ({ t: tokens }) as unknown as { t: Minter }],
      [
        'an array cast through unknown',
        () => ([tokens] as unknown as Minter[])[0]!.issue('a', TARGET),
      ],
      [
        'an object widened through spread',
        () => ({ ...{ t: tokens } }) as unknown as { t: Minter },
      ],
      [
        'a closure returning a cast',
        () => (() => tokens as unknown as Minter)().issue('a', TARGET),
      ],
      [
        'a generic Reflect.get wrapper with a joined name (141 probe, escape 1)',
        () => {
          function mint<T>(t: T): Promise<string> {
            return Reflect.get(t as object, ['is', 'sue'].join('')).call(t, 'a', TARGET, 'SERVICE');
          }
          return mint(tokens);
        },
      ],
      [
        'new InternalTokenService(…) as any',
        () => (new InternalTokenService(SECRET, ISSUER, 300) as any as Minter).issue('a', TARGET),
      ],
      [
        'a computed name',
        () => (tokens as unknown as Record<string, Minter['issue']>)['is' + 'sue']!('a', TARGET),
      ],
      [
        'the prototype method with call',
        () => InternalTokenService.prototype.issue.call(tokens, 'a', TARGET),
      ],
      ['Reflect.apply', () => Reflect.apply(tokens.issue, tokens, ['a', TARGET])],
      ['bind', () => tokens.issue.bind(tokens)('a', TARGET)],
    ];

    it.each(snippets)('%s', (_name, run) => {
      const call = () => {
        const value = run();
        // The two container snippets hand back the container; reach issue() on it.
        if (value && typeof value === 'object' && 't' in value) {
          return (value as { t: Minter }).t.issue('a', TARGET);
        }
        return value;
      };
      expect(call).toThrow(TypeError);
      expect(call).toThrow(NOT_CALLABLE);
    });

    it('an object built on the prototype is not an issuer: the client asks its issue(), which refuses', async () => {
      const fake = Object.create(InternalTokenService.prototype) as InternalTokenService;
      await expect(new InternalHttpClient(fake).authorize(GRANT)).rejects.toThrow(NOT_CALLABLE);
      await expect(fake.verify('x.y.z', TARGET)).rejects.toThrow(TypeError);
    });

    it('a subclass overriding issue() is ignored by the client and gains no key', async () => {
      class Loud extends InternalTokenService {
        override issue(): Promise<string> {
          return Promise.resolve('chosen-by-the-subclass');
        }
      }
      const loud = new Loud(SECRET, ISSUER, 300);
      const [token] = await minted(loud);
      expect(token).not.toBe('chosen-by-the-subclass');
      await expect(tokens.verify(token!, TARGET)).resolves.toMatchObject({
        organizationId: 'org-1',
      });
      expect(Reflect.ownKeys(loud)).toEqual([]);
    });

    it('a sender test stand-in still answers through its own issue()', async () => {
      const standIn = { issue: jest.fn().mockResolvedValue('stand-in-token') };
      const sender = await new InternalHttpClient(standIn, async (_input, init) => {
        expect(new Headers(init?.headers).get('x-internal-token')).toBe('stand-in-token');
        return new Response(null, { status: 204 });
      }).authorize(GRANT);
      await sender.send('http://economic.invalid/', { method: 'GET' });
      expect(standIn.issue).toHaveBeenCalledWith('contract-service', TARGET, 'SERVICE', 'org-1');
    });
  });

  describe('141 probe, escape 2: the key is no property of anything outside the module', () => {
    it('the issuer has no own keys, no symbols and nothing that prints the secret', () => {
      expect(Reflect.ownKeys(tokens)).toEqual([]);
      expect(Object.getOwnPropertySymbols(tokens)).toEqual([]);
      expect(JSON.stringify(tokens)).toBe('{}');
      const printed = inspect(tokens, { showHidden: true, depth: Infinity, getters: true });
      expect(printed).not.toContain(SECRET);
      expect(printed).not.toMatch(/Uint8Array/);
      for (const name of ['key', 'secret', 'issuer', 'ttlSeconds', ['k', 'ey'].join('')]) {
        expect(Reflect.get(tokens, name)).toBeUndefined();
      }
    });

    it('the class adds nothing but its methods: no getter, no static that hands out the key', () => {
      for (const holder of [InternalTokenService.prototype, InternalTokenService]) {
        for (const key of Reflect.ownKeys(holder)) {
          const descriptor = Reflect.getOwnPropertyDescriptor(holder, key)!;
          expect({ key, get: descriptor.get }).toEqual({ key, get: undefined });
          expect(descriptor.value).not.toBeInstanceOf(Uint8Array);
        }
      }
      expect(Reflect.ownKeys(InternalTokenService.prototype).sort()).toEqual(
        ['constructor', 'issue', 'verify'].sort(),
      );
    });

    it('a token signed with what Reflect.get finds under the key name is refused', async () => {
      const found = Reflect.get(tokens, ['k', 'ey'].join('')) as Uint8Array | undefined;
      const guessed = found ?? new TextEncoder().encode('not-the-secret-'.repeat(3));
      const forged = await new SignJWT({ svc: 'x', purpose: 'SERVICE', org_id: 'org-1' })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuer(ISSUER)
        .setAudience(TARGET)
        .setSubject('x')
        .setIssuedAt()
        .setExpirationTime('300s')
        .sign(guessed);
      await expect(tokens.verify(forged, TARGET)).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
    });

    it('the client is frozen: its transport and issuer cannot be swapped afterwards', async () => {
      const client = new InternalHttpClient(
        tokens,
        async () => new Response(null, { status: 204 }),
      );
      expect(Object.isFrozen(client)).toBe(true);
      const capture: typeof fetch = async () => new Response(null, { status: 204 });
      expect(Reflect.set(client, 'fetchImpl', capture)).toBe(false);
      expect(Reflect.set(client, 'tokens', { issue: async () => 'x' })).toBe(false);
      expect(Reflect.get(client, 'tokens')).toBe(tokens);
    });
  });

  describe('review F2: computed header names cannot put a chosen token on the wire', () => {
    it.each([
      ['a joined name', { [['x', 'internal', 'token'].join('-')]: 'forged' }],
      ['an upper-cased name lowered at run time', { ['X-INTERNAL-TOKEN'.toLowerCase()]: 'forged' }],
      ['a mixed-case name', { ['X-Internal-' + 'Token']: 'forged' }],
    ])('%s is replaced by the client token', async (_name, headers) => {
      const seen = await minted(tokens, headers);
      expect(seen).toHaveLength(1);
      expect(seen[0]).not.toBe('forged');
      await expect(tokens.verify(seen[0]!, TARGET)).resolves.toBeDefined();
    });
  });

  describe('review F2: subpath imports of the signer module', () => {
    const PACKAGE = resolve(__dirname, '../..');
    const CONSUMER = resolve(PACKAGE, '../../services/economic-service');

    it('the manifest exports the package entry point and nothing else', () => {
      const manifest = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')) as {
        exports?: unknown;
      };
      expect(manifest.exports).toEqual({
        '.': { types: './dist/index.d.ts', default: './dist/index.js' },
      });
    });

    it('Node refuses every subpath from a real consumer, for require and import', () => {
      const specifiers = [
        '@rasta/nest-common/dist/http/internal-http-client.js',
        '@rasta/nest-common/dist/http/internal-http-client',
        '@rasta/nest-common/dist/auth/token-verifier.js',
        '@rasta/nest-common/dist/index.js',
        '@rasta/nest-common/src/http/internal-http-client.ts',
        '@rasta/nest-common/package.json',
        '@rasta/nest-common/' + ['dist', 'http', 'internal-http-client.js'].join('/'),
      ];
      const script = `
        const { createRequire } = require('node:module');
        const req = createRequire(${JSON.stringify(join(CONSUMER, 'package.json'))});
        const out = {};
        (async () => {
          for (const s of JSON.parse(process.argv[1])) {
            const r = {};
            try { req.resolve(s); r.require = 'resolved'; } catch (e) { r.require = e.code; }
            try { await import(s); r.import = 'loaded'; } catch (e) { r.import = e.code; }
            out[s] = r;
          }
          process.stdout.write(JSON.stringify(out));
        })();`;
      const result = spawnSync(process.execPath, ['-e', script, JSON.stringify(specifiers)], {
        cwd: CONSUMER,
        encoding: 'utf8',
      });
      expect(result.stderr).toBe('');
      const outcome = JSON.parse(result.stdout) as Record<
        string,
        { require: string; import: string }
      >;
      for (const specifier of specifiers) {
        expect({ specifier, ...outcome[specifier] }).toEqual({
          specifier,
          require: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
          import: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
        });
      }
    });

    it('jose signing without the key yields nothing a service accepts', async () => {
      const forged = await new SignJWT({ svc: 'x', purpose: 'SERVICE' })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuer(ISSUER)
        .setAudience(TARGET)
        .setSubject('x')
        .setIssuedAt()
        .setExpirationTime('300s')
        .sign(new TextEncoder().encode('x'.repeat(40)));
      await expect(tokens.verify(forged, TARGET)).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
    });
  });

  describe('residual, documented (141 probe, escape 3; D-086)', () => {
    it('the transport a client is built with sees the token it sends: one audience, one organization, one TTL', async () => {
      const [captured] = await minted(tokens);
      await expect(tokens.verify(captured!, TARGET)).resolves.toMatchObject({
        organizationId: 'org-1',
      });
      await expect(tokens.verify(captured!, 'notification-service')).rejects.toMatchObject({
        code: 'TOKEN_INVALID',
      });
    });
  });
});
