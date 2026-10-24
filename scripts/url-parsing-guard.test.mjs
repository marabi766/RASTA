// -----------------------------------------------------------------------------
// No native URL parse of configuration outside @rasta/config's reader (#385 r5).
//
//   pnpm test:url-parsing-guard
//
// `new URL(value)` refuses with a TypeError that keeps the whole value on
// `.input` (the base on `.base`), and Node prints it for an uncaught throw —
// a database URL's password included (Codex PR-385 r4 F1). Configuration is
// parsed by `readUrl`/`tryReadUrl` (packages/config/src/url-reader.js), which
// refuse with a fixed text. Every other parse of a value that is not a literal
// in scripts/, packages/, services/, apps/ and tests/ — test files aside, see
// `isTestFile` — must be in ALLOWED below, with the reason it cannot carry
// configuration. A new one fails here; so does an entry that no longer
// matches anything.
//
// Two premises of the class boundary are held here too: no command-line flag
// takes a credential or a URL (configuration with a secret arrives through the
// environment), and every service-to-service base URL setting is read with
// `serviceUrlSchema` (an http(s) URL without credentials — `fetch` repeats a
// URL with credentials whole in its TypeError).
// -----------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CREDENTIAL_FLAG,
  credentialFlags,
  isTestFile,
  rawUrlParses,
  repositoryUrlParses,
  sourceFiles,
  unlistedUrlParses,
} from './url-parsing-guard-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Each parse of a non-literal that stays, and why it cannot carry configuration. */
const ALLOWED = Object.freeze([
  {
    file: 'packages/config/src/url-reader.js',
    call: 'new URL(value)',
    reason: 'the reader itself: the native error is discarded, a fixed text is thrown',
  },
  {
    file: 'packages/config/src/url-reader.js',
    call: 'new URL(value, base)',
    reason: 'the reader itself: the native error is discarded, a fixed text is thrown',
  },
  {
    file: 'scripts/verify-migration-reversible-lib.mjs',
    call: 'new URL( `../services/identity-service/prisma/migrations/${MEMBERSHIP_GUARD}/migration.sql`, import.meta.url, )',
    reason: 'a repository file: a constant migration name against import.meta.url',
  },
  {
    file: 'services/identity-service/test/audit-stub.ts',
    call: "new URL(request.url ?? '/', 'http://stub.invalid')",
    reason: "the stub server's incoming request path against a literal base; no configuration",
  },
  {
    file: 'apps/web/src/app/AccountBoundary.tsx',
    call: 'new URL(form.action, window.location.href)',
    reason: 'browser: a form action against the page location; no configuration',
  },
  {
    file: 'apps/web/src/app/ConsumedFlash.tsx',
    call: 'new URL(window.location.href)',
    reason: "browser: the page's own location; no configuration",
  },
  {
    file: 'apps/web/src/app/auth/callback/route.ts',
    call: 'new URL(request.url)',
    reason: 'the incoming request URL, built by Next.js; no configuration',
  },
  {
    file: 'apps/web/src/app/auth/login/route.ts',
    call: 'new URL(request.url)',
    reason: 'the incoming request URL, built by Next.js; no configuration',
  },
  {
    file: 'apps/web/src/app/auth/logout/route.ts',
    call: 'new URL(endpointsFor(env.OIDC_ISSUER_URL).endSession)',
    reason:
      'OIDC_ISSUER_URL is refused at boot unless it parses as http(s) without credentials ' +
      '(apps/web/src/server/env.ts httpUrl); a path is appended to it',
  },
  {
    file: 'apps/web/src/server/asset-documents.ts',
    call: 'new URL(value)',
    reason: "inside try/catch returning false; the value is document-service's signed URL",
  },
  {
    file: 'apps/web/src/server/env.ts',
    call: 'new URL(value)',
    reason: 'inside try/catch returning true (`.url()` refuses it): the native error is discarded',
  },
  {
    file: 'apps/web/src/server/gateway.ts',
    call: 'new URL(baseUrl)',
    reason:
      'API_GATEWAY_URL, refused at boot unless it parses as http(s) without credentials ' +
      '(apps/web/src/server/env.ts httpUrl)',
  },
  {
    file: 'apps/web/src/server/gateway.ts',
    call: 'new URL(path, base)',
    reason: "the portal's own path against the boot-validated gateway base",
  },
  {
    file: 'apps/web/src/server/oidc.ts',
    call: 'new URL(request.endpoints.authorization)',
    reason: 'built from OIDC_ISSUER_URL, refused at boot unless it parses (env.ts httpUrl)',
  },
  {
    file: 'apps/web/src/server/oidc.ts',
    call: 'new URL(url)',
    reason: 'the JWKS URL built from OIDC_ISSUER_URL, refused at boot unless it parses',
  },
  {
    file: 'apps/web/e2e/contract-fixture.ts',
    call: "new URL(requiredEnv('WEB_E2E_CONTRACT_DATABASE_URL'))",
    reason:
      "a Playwright fixture on CI's disposable contract database; apps/web has no " +
      '@rasta/config dependency, and the fixture runs only inside the browser test job',
  },
  {
    file: 'tests/e2e/src/target-guard.ts',
    call: 'new URL(value)',
    reason: 'inside try/catch returning undefined: the native error is discarded',
  },
]);

/** zod `.url()` settings in a service's configuration that stay, and why. */
const ALLOWED_ZOD_URL_SETTINGS = Object.freeze({
  S3_ENDPOINT:
    'read by the AWS SDK (its own HTTP handler, not fetch), and the endpoint is never ' +
    'printed by document-service',
});

const sites = (text, file = 'x.mjs') => rawUrlParses(text, file).map((site) => site.kind);

test('every form of a native URL parse is found', () => {
  assert.deepEqual(sites('new URL(process.env.X)'), ['new URL']);
  assert.deepEqual(sites('new globalThis.URL(raw)'), ['new URL']);
  assert.deepEqual(sites("import url from 'node:url'; new url.URL(raw)"), ['new URL']);
  assert.deepEqual(sites('URL.parse(raw)'), ['URL.parse']);
  assert.deepEqual(sites('URL.canParse(raw)'), ['URL.canParse']);
  assert.deepEqual(sites("import { parse } from 'node:url'; parse(raw)"), ['url.parse']);
  assert.deepEqual(sites("import { parse as p } from 'url'; p(raw)"), ['url.parse']);
  assert.deepEqual(sites("import * as u from 'node:url'; u.parse(raw)"), ['url.parse']);
  assert.deepEqual(sites("import u from 'url'; u.parse(raw)"), ['url.parse']);
  assert.deepEqual(sites("const u = require('node:url'); u.parse(raw)", 'x.cjs'), ['url.parse']);
  assert.deepEqual(sites("const { parse } = require('url'); parse(raw)", 'x.cjs'), ['url.parse']);
  // Split over lines, and in TypeScript with a type annotation around it.
  assert.deepEqual(sites('const u: URL = new URL(\n  env.X as string,\n);', 'x.ts'), ['new URL']);
  // A literal path against a base from configuration: the base is on `.base`.
  assert.deepEqual(sites("new URL('/v1/users', this.options.baseUrl)", 'x.ts'), ['new URL']);
  // A template with a substitution is not a literal.
  assert.deepEqual(sites('new URL(`${base}/x`)'), ['new URL']);
});

test('literals, import.meta.url, comments and other parse methods are not sites', () => {
  assert.deepEqual(sites("new URL('http://localhost:3000/x')"), []);
  assert.deepEqual(sites('new URL(`http://localhost/x`)'), []);
  assert.deepEqual(sites("new URL('../x.sql', import.meta.url)"), []);
  assert.deepEqual(sites('// new URL(process.env.X) is how it used to be\n'), []);
  assert.deepEqual(sites("const text = 'new URL(process.env.X)';"), []);
  assert.deepEqual(sites('JSON.parse(raw); path.parse(raw); new URLSearchParams(raw);'), []);
  // `parse` from another module is not `node:url`'s.
  assert.deepEqual(sites("import { parse } from 'node:path'; parse(raw)"), []);
});

test('test files are left out, test helpers are not', () => {
  for (const file of [
    'services/a/test/x.int-spec.ts',
    'services/a/src/x.spec.ts',
    'apps/web/src/x.spec.tsx',
    'scripts/x.test.mjs',
    'scripts/x.pg.test.mjs',
    'tests/e2e/specs/x.e2e-spec.ts',
    'packages/a/src/__tests__/x.fixture.ts',
  ]) {
    assert.equal(isTestFile(file), true, file);
  }
  for (const file of [
    'services/a/test/helpers.ts',
    'scripts/runtime-preflight.e2e.mjs',
    'scripts/refusal-probes.mjs',
    'tests/e2e/src/target-guard.ts',
  ]) {
    assert.equal(isTestFile(file), false, file);
  }
});

test('an unlisted site fails, and so does a stale entry', () => {
  const found = [{ file: 'a.mjs', line: 1, kind: 'new URL', call: 'new URL(raw)' }];
  assert.deepEqual(unlistedUrlParses(found, []).unlisted, found);
  const entry = { file: 'a.mjs', call: 'new  URL(raw)', reason: 'r' };
  assert.deepEqual(unlistedUrlParses(found, [entry]), { unlisted: [], stale: [] });
  assert.deepEqual(unlistedUrlParses([], [entry]).stale, [entry]);
  // Another file's identical call is not covered.
  assert.equal(unlistedUrlParses([{ ...found[0], file: 'b.mjs' }], [entry]).unlisted.length, 1);
});

test('every scanned tree is non-empty, and the reader itself is found', () => {
  const files = sourceFiles(ROOT);
  for (const tree of ['scripts/', 'packages/', 'services/', 'apps/', 'tests/']) {
    assert.ok(
      files.some((file) => file.startsWith(tree)),
      `nothing scanned under ${tree}`,
    );
  }
  // The reader's own two parses are seen: the scan reaches packages/config/src.
  const reader = repositoryUrlParses(ROOT).filter(
    (site) => site.file === 'packages/config/src/url-reader.js',
  );
  assert.equal(reader.length, 2);
});

test('no native URL parse of configuration outside the reader (allow-list aside)', () => {
  for (const entry of ALLOWED) {
    assert.ok(entry.reason.length > 20, `${entry.file}: an allow-list entry needs a reason`);
  }
  const { unlisted, stale } = unlistedUrlParses(repositoryUrlParses(ROOT), ALLOWED);
  assert.deepEqual(
    unlisted.map((site) => `${site.file}:${site.line} ${site.call}`),
    [],
    'parse configuration with readUrl/tryReadUrl from @rasta/config ' +
      '(scripts: ../packages/config/src/url-reader.js), or allow-list the site with a reason',
  );
  assert.deepEqual(
    stale.map((entry) => `${entry.file}: ${entry.call}`),
    [],
    'these allow-list entries match nothing any more; remove them',
  );
});

test('no command-line flag takes a credential or a URL', () => {
  assert.ok(CREDENTIAL_FLAG.test('--database-url'));
  assert.ok(CREDENTIAL_FLAG.test('--password-stdin'));
  assert.ok(!CREDENTIAL_FLAG.test('--security-opt'));
  assert.ok(!CREDENTIAL_FLAG.test('--with-database'));
  const flags = sourceFiles(ROOT)
    .filter((file) => !isTestFile(file))
    .flatMap((file) => {
      const text = readFileSync(join(ROOT, file), 'utf8');
      return text.includes('--') ? credentialFlags(text, file) : [];
    });
  assert.deepEqual(
    flags.map((flag) => `${flag.file}:${flag.line} ${flag.flag}`),
    [],
    'a credential or URL arrives through the environment, never argv (which the scripts echo)',
  );
});

test('every service base URL is read with serviceUrlSchema, and no bare zod .url()', () => {
  const configFiles = sourceFiles(ROOT).filter(
    (file) => /^services\/[^/]+\/src\/config\/[^/]+\.ts$/.test(file) && !isTestFile(file),
  );
  assert.ok(configFiles.length >= 17, "the services' configuration files were not found");
  const problems = [];
  const zodUrlSettings = new Set();
  for (const file of configFiles) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    for (const match of text.matchAll(
      /\b([A-Z][A-Z0-9_]*)\s*:\s*z\s*\.\s*string\(\)\s*\.\s*url\(/g,
    )) {
      zodUrlSettings.add(match[1]);
      if (!(match[1] in ALLOWED_ZOD_URL_SETTINGS)) {
        problems.push(`${file}: ${match[1]} uses z.string().url()`);
      }
    }
    for (const match of text.matchAll(
      /\b([A-Z][A-Z0-9_]*_SERVICE_URL|KEYCLOAK_URL)\s*:\s*([A-Za-z_.]+)/g,
    )) {
      if (match[2] !== 'serviceUrlSchema' && !match[2].startsWith('serviceUrlSchema.')) {
        problems.push(`${file}: ${match[1]} is read with ${match[2]}, not serviceUrlSchema`);
      }
    }
  }
  assert.deepEqual(problems, []);
  for (const setting of Object.keys(ALLOWED_ZOD_URL_SETTINGS)) {
    assert.ok(zodUrlSettings.has(setting), `${setting} is allow-listed but no longer uses .url()`);
  }
});
