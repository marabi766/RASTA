import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FINDINGS_SQL,
  PENDING_SPLIT,
  classifyServices,
  verdict,
} from './check-db-runtime-privileges-lib.mjs';
import { servicesFromLibrary, splitServicesFromLibrary } from './infra-preflight-lib.mjs';

test('every service is placed exactly once: split, audit or pending (D-045)', () => {
  const placed = classifyServices();
  assert.deepEqual(
    placed.map((entry) => entry.service),
    servicesFromLibrary(),
  );
  assert.deepEqual(
    placed
      .filter((entry) => entry.kind === 'split')
      .map((entry) => entry.service)
      .sort(),
    [...splitServicesFromLibrary()].sort(),
  );
  assert.ok(splitServicesFromLibrary().includes('construction'));
  assert.ok(!PENDING_SPLIT.includes('construction'));
  for (const entry of placed) {
    assert.equal(entry.database, `rasta_${entry.service}`);
    assert.equal(entry.runtime, `rasta_${entry.service}`);
  }
});

test('a service in no list, in two, or unknown is refused — a new service has to be placed', () => {
  const services = ['a', 'b', 'audit'];
  assert.throws(
    () => classifyServices({ services, split: ['a'], pending: [] }),
    /b: in RASTA_SERVICES but neither split nor pending/,
  );
  assert.throws(
    () => classifyServices({ services, split: ['a', 'b'], pending: ['b'] }),
    /b is both split and pending/,
  );
  assert.throws(
    () => classifyServices({ services, split: ['a', 'b', 'c'], pending: [] }),
    /c is not in RASTA_SERVICES/,
  );
});

test('a split service fails on any finding and passes on none', () => {
  const split = { service: 'construction', kind: 'split' };
  assert.equal(verdict(split, []).ok, true);
  const failed = verdict(split, ['TRIGGER on public.tender', 'owns table public.tender']);
  assert.equal(failed.ok, false);
  assert.match(failed.line, /TRIGGER on public\.tender/);
  assert.match(failed.line, /owns table public\.tender/);
  assert.equal(
    verdict({ service: 'audit', kind: 'audit' }, ['owns database rasta_audit']).ok,
    false,
  );
});

test('a pending service must still fail: one that passes is a stale entry, and fails the check', () => {
  const pending = { service: 'economic', kind: 'pending' };
  assert.equal(verdict(pending, ['owns database rasta_economic']).ok, true);
  const stale = verdict(pending, []);
  assert.equal(stale.ok, false);
  assert.match(stale.line, /move it to PRIVILEGE_SPLIT_SERVICES/);
});

test('the query asks about every right the PM ruled out, through role membership', () => {
  for (const fragment of [
    'rolsuper',
    'rolcreatedb',
    'rolcreaterole',
    'rolbypassrls',
    "'owns database '",
    "'CREATE on database '",
    "'owns schema '",
    "'CREATE on schema '",
    "'owns function '",
    "'owns type '",
    "'TRUNCATE', 'REFERENCES', 'TRIGGER'",
    '_prisma_migrations',
    "pg_has_role(me.oid, t.relowner, 'USAGE')",
  ]) {
    assert.ok(FINDINGS_SQL.includes(fragment), fragment);
  }
  assert.match(FINDINGS_SQL, /rolname = :'runtime'/);
});
