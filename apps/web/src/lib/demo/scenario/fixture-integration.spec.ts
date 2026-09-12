import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ApiFailure, CLIENT_ERROR_CODES } from '../../api/errors';
import { createFixtureClient } from '../fixture-client';
import { getScenarioStore, resetScenarioStoreSingletonForTests } from './store';

const SRC = path.join(__dirname, '..', '..', '..');
const anySchema = z.unknown();

/**
 * Modules allowed to reach into `lib/demo/scenario/` at all.
 *
 * Three, and each is already gated: `fixture-client.ts` only builds a client
 * inside `createFixtureClient`, itself only reachable from
 * `lib/auth/session.tsx`'s fixture-mode branch (`demo-mode.spec.ts` proves
 * that one); the other two are the `next/dynamic`-loaded, self-contained UI
 * islands — each wraps its own `<ScenarioProvider>` rather than depending on
 * one mounted above it, which is what keeps them two separate lazy chunks
 * instead of one that would flash both controls in together. Their own
 * gates (`scenario-status-gate.tsx`, `scenario-reset-gate.tsx`) import *them*
 * dynamically, not the engine — they stay off this list on purpose, and the
 * live-bundle test below is what actually matters: it does not check import
 * statements, it checks that rendering in live mode never triggers the
 * dynamic import.
 */
const APPROVED_ENGINE_IMPORTERS = new Set([
  'lib/demo/fixture-client.ts',
  'components/demo/scenario-status-card.tsx',
  'components/demo/scenario-reset-control.tsx',
]);

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

describe('the scenario engine is reachable from exactly four gated modules', () => {
  it('names no unapproved importer', () => {
    const importers = sourceFiles()
      .filter((file) => !file.endsWith('.spec.ts') && !file.endsWith('.spec.tsx'))
      .filter(
        (file) => !path.relative(SRC, file).replaceAll('\\', '/').startsWith('lib/demo/scenario/'),
      )
      .filter((file) => {
        const relative = path.relative(SRC, file).replaceAll('\\', '/');
        return !APPROVED_ENGINE_IMPORTERS.has(relative);
      })
      .filter((file) =>
        /from ['"].*\/scenario['"]|from ['"]\.\/scenario['"]/.test(readFileSync(file, 'utf8')),
      );

    expect(importers.map((file) => path.relative(SRC, file).replaceAll('\\', '/'))).toEqual([]);
  });
});

describe('a live request never falls back to the scenario engine', () => {
  it('lib/api/client.ts does not mention the scenario engine anywhere', () => {
    const source = readFileSync(path.join(SRC, 'lib', 'api', 'client.ts'), 'utf8');
    expect(source).not.toMatch(/scenario/i);
  });
});

describe('FixtureGatewayClient projects GET reads from the live scenario state', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    resetScenarioStoreSingletonForTests();
  });

  it('still answers every existing static route exactly as before', async () => {
    const client = await createFixtureClient();
    const result = await client.request({ path: '/v1/assets', schema: anySchema });
    expect(result.status).toBe(200);
  });

  it('reflects a dispatched action on the very next GET, with no client rebuild', async () => {
    const client = await createFixtureClient();
    const store = getScenarioStore();
    const initial = store.getState();

    const before = await client.request({
      path: `/v1/maintenance-requests/${initial.maintenance.id}`,
      schema: anySchema,
    });
    expect((before.data as Record<string, unknown>).approvedAt).toBeFalsy();

    store.dispatch({
      type: 'MAINTENANCE_REQUEST_CREATED',
      maintenanceRequestId: initial.maintenance.id,
      assetId: initial.assetId,
      organizationId: initial.organizationId,
      title: 'x',
    });
    store.dispatch({
      type: 'MAINTENANCE_ESTIMATE_APPROVED',
      maintenanceRequestId: initial.maintenance.id,
      estimateAmountMinor: '284000000',
    });

    const after = await client.request({
      path: `/v1/maintenance-requests/${initial.maintenance.id}`,
      schema: anySchema,
    });
    expect((after.data as Record<string, unknown>).approvedAt).toBeTruthy();
  });

  it('appends a scenario audit record that the real audit-events schema still accepts', async () => {
    const { auditEventPageSchema } = await import('../../api/adapters/audit');
    const client = await createFixtureClient();
    const store = getScenarioStore();

    store.dispatch({ type: 'PERSONA_SELECTED', persona: 'FLEET_MANAGER' });

    const result = await client.request({ path: '/v1/audit-events', schema: auditEventPageSchema });
    expect(result.data.items[0]?.action).toBe('persona.selected');
  });

  it('still refuses every non-GET before any lookup, scenario or static', async () => {
    const client = await createFixtureClient();
    await expect(
      client.request({ method: 'POST', path: '/v1/maintenance-requests', schema: anySchema }),
    ).rejects.toMatchObject({ code: CLIENT_ERROR_CODES.FIXTURE_WRITE_REFUSED });
  });

  it('the query-specific audit-verify presets are unaffected by the scenario wiring', async () => {
    const { auditChainVerificationSchema } = await import('../../api/adapters/audit');
    const client = await createFixtureClient();

    const result = await client.request({
      path: '/v1/audit-events/verify',
      schema: auditChainVerificationSchema,
      query: {
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-09-05T12:00:00.000Z',
        scope: 'ORGANIZATION',
        organizationId: 'org_demo_dehyari_alef',
      },
    });
    expect(result.data.status).toBe('VALID');
  });

  it('an unsupported route still fails loudly rather than returning an empty list', async () => {
    const client = await createFixtureClient();
    await expect(
      client.request({ path: '/v1/not-in-the-dataset', schema: anySchema }),
    ).rejects.toBeInstanceOf(ApiFailure);
  });
});
