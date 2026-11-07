// -----------------------------------------------------------------------------
// Every ingress CORS policy carries every header the published API names (FU-172).
//
//   pnpm test:cors-published-headers
//
// A request header a browser script sends that is off a policy's `allowedHeaders`
// fails the preflight: the command never leaves the browser. A response header off
// `exposedHeaders` arrives but the script cannot read it. PR-844 r1 F2: the new
// `Idempotency-Replay-Deadline` reached the OpenAPI documents and the gateway's
// forwarding filter, but no CORS policy — so a cross-origin client could not send
// the fence at all.
//
// The published contract is every `in: header` parameter (request) and every
// response `headers` entry in docs/api/*.openapi.json, planned documents included.
// The ingress policies are the gateway's (services/api-gateway/src/http/cors.ts)
// and each service's direct one (services/*/src/main.ts). Each COMMAND policy must
// allow every published request header and expose every published response
// header, whichever service published it: the gateway fronts them all, and a
// header one service adds today is the next one's tomorrow. A READ-ONLY policy
// (the services listed below, which accept no keyed command) is accepted only while
// its own documents publish no header either way. Anything the scan cannot read —
// a policy without a literal list, a service missing from both groups, an
// unreadable document — fails.
// -----------------------------------------------------------------------------
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { authoredFiles } from './authored-source-inventory.cjs';

const root = join(import.meta.dirname, '..');
const servicesDir = join(root, 'services');
const docsDir = join(root, 'docs', 'api');

/** Policies that deliberately admit no command header: reads only. */
const READ_ONLY = new Set(['analytics-service', 'audit-service', 'notification-service']);

/** The string literals of `<field>: [ ... ]` in a policy's source; `null` when there is none. */
export function listedHeaders(source, field) {
  const found = [...source.matchAll(new RegExp(`\\b${field}:\\s*\\[([^\\]]*)\\]`, 'g'))];
  if (found.length !== 1) return null;
  const body = found[0][1].replace(/\/\/[^\n]*/g, '');
  const items = [...body.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => (m[1] ?? m[2]).toLowerCase());
  // Anything but quoted literals (a spread, an identifier) is a list this scan cannot prove.
  const rest = body.replace(/'[^']*'|"[^"]*"/g, '').replace(/[\s,]/g, '');
  return rest === '' ? items : null;
}

/** Published request and response header names of one OpenAPI document, lower-cased. */
export function publishedHeaders(doc) {
  const request = new Set();
  const response = new Set();
  const resolve = (node) => {
    if (node && typeof node.$ref === 'string') {
      const path = node.$ref.replace(/^#\//, '').split('/');
      let target = doc;
      for (const part of path) target = target?.[part];
      assert.ok(target, `unresolvable $ref ${node.$ref}`);
      return target;
    }
    return node;
  };
  for (const item of Object.values(doc.paths ?? {})) {
    const operations = Object.entries(item).filter(([method]) =>
      ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'].includes(method),
    );
    const shared = item.parameters ?? [];
    for (const [, operation] of operations) {
      for (const raw of [...shared, ...(operation.parameters ?? [])]) {
        const parameter = resolve(raw);
        if (parameter.in === 'header') request.add(String(parameter.name).toLowerCase());
      }
      for (const rawResponse of Object.values(operation.responses ?? {})) {
        for (const name of Object.keys(resolve(rawResponse).headers ?? {})) {
          response.add(name.toLowerCase());
        }
      }
    }
  }
  return { request, response };
}

/** What a policy misses of the published headers: empty when it carries them all. */
export function missingFrom(policy, published) {
  return {
    allowed: [...published.request].filter((h) => !policy.allowed.includes(h)).sort(),
    exposed: [...published.response].filter((h) => !policy.exposed.includes(h)).sort(),
  };
}

// Git's file lists (the inventory), never a directory listing.
const docs = authoredFiles(docsDir)
  .filter((file) => relative(docsDir, file) === basename(file) && file.endsWith('.openapi.json'))
  .map((file) => basename(file))
  .map((name) => ({
    service: name.split('.')[0],
    name,
    headers: publishedHeaders(JSON.parse(readFileSync(join(docsDir, name), 'utf8'))),
  }));
const union = { request: new Set(), response: new Set() };
for (const { headers } of docs) {
  headers.request.forEach((h) => union.request.add(h));
  headers.response.forEach((h) => union.response.add(h));
}

const policies = [
  { name: 'api-gateway', file: join(servicesDir, 'api-gateway', 'src', 'http', 'cors.ts') },
  ...authoredFiles(servicesDir)
    .map((file) => relative(servicesDir, file).split(sep))
    .filter((parts) => parts.length === 3 && parts[1] === 'src' && parts[2] === 'main.ts')
    .map(([name]) => name)
    .filter((name) => name !== 'api-gateway')
    .map((name) => ({ name, file: join(servicesDir, name, 'src', 'main.ts') })),
];

test('the scan finds the documents, the published fence and the policies (an empty scan is no gate)', () => {
  assert.ok(docs.length >= 8, `found only ${docs.length} OpenAPI documents`);
  assert.ok(union.request.has('idempotency-key'));
  assert.ok(union.request.has('idempotency-replay-deadline'));
  assert.ok(union.response.has('retry-after'));
  assert.ok(policies.length >= 17, `found only ${policies.length} CORS policies`);
});

test('the check fails when a published header is missing from a policy', () => {
  const policy = listedHeaders(
    "allowedHeaders: [\n  'authorization', // why\n  'Idempotency-Key',\n],",
    'allowedHeaders',
  );
  assert.deepEqual(policy, ['authorization', 'idempotency-key']);
  const published = {
    request: new Set(['idempotency-key', 'idempotency-replay-deadline']),
    response: new Set(['retry-after']),
  };
  assert.deepEqual(missingFrom({ allowed: policy, exposed: ['etag'] }, published), {
    allowed: ['idempotency-replay-deadline'],
    exposed: ['retry-after'],
  });
  // A list the scan cannot read is refused, never taken as complete.
  assert.equal(listedHeaders("allowedHeaders: [...BASE, 'x'],", 'allowedHeaders'), null);
  assert.equal(listedHeaders('exposedHeaders: HEADERS,', 'exposedHeaders'), null);
});

for (const { name, file } of policies) {
  test(`${name}: its CORS policy carries every published header`, () => {
    const source = readFileSync(file, 'utf8');
    const allowed = listedHeaders(source, 'allowedHeaders');
    const exposed = listedHeaders(source, 'exposedHeaders');
    assert.ok(allowed, `${name}: no single literal allowedHeaders list`);
    assert.ok(exposed, `${name}: no single literal exposedHeaders list`);

    if (READ_ONLY.has(name)) {
      for (const doc of docs.filter((d) => d.service === name)) {
        assert.deepEqual(
          { request: [...doc.headers.request], response: [...doc.headers.response] },
          { request: [], response: [] },
          `${doc.name} publishes headers, so ${name} is no longer read-only: allow them all`,
        );
      }
      assert.ok(
        !allowed.includes('idempotency-key'),
        `${name} accepts Idempotency-Key: it is a command policy, remove it from READ_ONLY`,
      );
      return;
    }
    assert.deepEqual(
      missingFrom({ allowed, exposed }, union),
      { allowed: [], exposed: [] },
      `${name}: published headers missing from its CORS policy`,
    );
  });
}
