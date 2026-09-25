import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateComposePorts } from './check-compose-ports-lib.mjs';

const COMPOSE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docker-compose.yml');

const service = (...ports) =>
  ['services:', '  x:', '    image: y', '    ports:', ...ports.map((p) => `      - '${p}'`)].join(
    '\n',
  );

test('the committed compose file binds every published port to loopback', () => {
  const { errors, checked } = validateComposePorts(readFileSync(COMPOSE, 'utf8'));
  assert.deepEqual(errors, []);
  assert.ok(checked >= 19, `expected every mapping to be seen, saw ${checked}`);
});

test('accepts the configurable loopback default and a literal 127.0.0.1', () => {
  const { errors, checked } = validateComposePorts(
    service('${COMPOSE_BIND_ADDRESS:-127.0.0.1}:6379:6379', '127.0.0.1:${CLAMAV_PORT:-3310}:3310'),
  );
  assert.deepEqual(errors, []);
  assert.equal(checked, 2);
});

for (const spec of ['6379:6379', '${POSTGRES_PORT:-5432}:5432', '0.0.0.0:8080:8080', '8080']) {
  test(`refuses ${spec}`, () => {
    const { errors } = validateComposePorts(service(spec));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /every interface/);
  });
}

test('ignores comments inside a ports block and stops at the next key', () => {
  const text = [
    '    ports:',
    '      # loopback only',
    "      - '127.0.0.1:1:1'",
    '    volumes:',
    "      - './a:/b'",
  ].join('\n');
  assert.deepEqual(validateComposePorts(text), { errors: [], checked: 1 });
});
