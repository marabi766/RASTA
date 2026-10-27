import request from 'supertest';
import type { Server } from 'node:http';
import { startApi, systemAdmin, unionAdmin, type ApiHarness } from './api-helpers';
import { orgId, queryWindow } from './fixtures';

/**
 * PR #444 r1 F1, reproduced over HTTP: the real application, its guards and
 * its query pipes, an authorized caller and a valid `from`/`to` window, so
 * the only refusal is the one under test. The 400's details are what zod 3
 * answered — recorded by running this file unchanged on main `745d0434`
 * (`~/worker2/session/t109/scripts/record.sh`); the r1 head answered
 * `limit=1e999` with a single `Invalid input: expected number, received
 * Infinity`. A numeric `action` cannot travel in a query string; it is a
 * pipe-level input, pinned in `src/audit/zod3-diagnostics.golden.spec.ts`.
 * The two `limit=0.5` cases are Codex PR-444 r2 F1's, recorded the same way on
 * main `5c88ae21` (`~/worker6/session/039/scripts/record.sh`); the r2 head
 * answered both with the two `limit` details only.
 */

/** Recorded under zod 3 on main 745d0434 (r2 F1 cases: 5c88ae21); never written by a test run. */
const ZOD3: Record<string, unknown> = {
  'SYSTEM_ADMIN limit=1e999': {
    code: 'VALIDATION_FAILED',
    details: [
      { path: 'limit', message: 'Expected integer, received float', code: 'invalid_type' },
      { path: 'limit', message: 'Number must be less than or equal to 200', code: 'too_big' },
    ],
  },
  'SYSTEM_ADMIN limit=nope': {
    code: 'VALIDATION_FAILED',
    details: [{ path: 'limit', message: 'Expected number, received nan', code: 'invalid_type' }],
  },
  'SYSTEM_ADMIN limit=201': {
    code: 'VALIDATION_FAILED',
    details: [
      { path: 'limit', message: 'Number must be less than or equal to 200', code: 'too_big' },
    ],
  },
  'SYSTEM_ADMIN outcome=MAYBE': {
    code: 'VALIDATION_FAILED',
    details: [
      {
        path: 'outcome',
        message: "Invalid enum value. Expected 'SUCCESS' | 'FAILURE' | 'REFUSED'",
        code: 'invalid_enum_value',
      },
    ],
  },
  'SYSTEM_ADMIN verify, with a limit it does not take': {
    code: 'VALIDATION_FAILED',
    details: [
      { path: '(root)', message: 'Unrecognized key(s) in object (1)', code: 'unrecognized_keys' },
    ],
  },
  'SYSTEM_ADMIN limit=0.5, a resource id without its type, a bad cursor': {
    code: 'VALIDATION_FAILED',
    details: [
      { path: 'limit', message: 'Expected integer, received float', code: 'invalid_type' },
      { path: 'limit', message: 'Number must be greater than or equal to 1', code: 'too_small' },
      {
        path: 'resourceType',
        message: '`resourceId` may only be used together with `resourceType`',
        code: 'custom',
      },
      { path: 'cursor', message: 'The cursor is not valid', code: 'custom' },
    ],
  },
  'SYSTEM_ADMIN the same, window reversed': {
    code: 'VALIDATION_FAILED',
    details: [
      { path: 'limit', message: 'Expected integer, received float', code: 'invalid_type' },
      { path: 'limit', message: 'Number must be greater than or equal to 1', code: 'too_small' },
      { path: 'to', message: '`to` must not be earlier than `from`', code: 'custom' },
      {
        path: 'resourceType',
        message: '`resourceId` may only be used together with `resourceType`',
        code: 'custom',
      },
      { path: 'cursor', message: 'The cursor is not valid', code: 'custom' },
    ],
  },
  'UNION_ADMIN limit=1e999': {
    code: 'VALIDATION_FAILED',
    details: [
      { path: 'limit', message: 'Expected integer, received float', code: 'invalid_type' },
      { path: 'limit', message: 'Number must be less than or equal to 200', code: 'too_big' },
    ],
  },
};

function matchesZod3(name: string, observed: unknown): void {
  expect(observed).toEqual(ZOD3[name]);
}

describe('audit query refusals over HTTP, as zod 3 worded them (real guards, valid window)', () => {
  let api: ApiHarness;
  let server: Server;
  const window = queryWindow();

  beforeAll(async () => {
    api = await startApi();
    server = api.app.getHttpServer() as Server;
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  }, 120_000);

  it.each([
    ['SYSTEM_ADMIN limit=1e999', '/v1/audit-events', { limit: '1e999' }],
    ['SYSTEM_ADMIN limit=nope', '/v1/audit-events', { limit: 'nope' }],
    ['SYSTEM_ADMIN limit=201', '/v1/audit-events', { limit: '201' }],
    ['SYSTEM_ADMIN outcome=MAYBE', '/v1/audit-events', { outcome: 'MAYBE' }],
    // Codex PR-444 r2 F1: zod 4 stopped at the integer, and lost both refinements.
    [
      'SYSTEM_ADMIN limit=0.5, a resource id without its type, a bad cursor',
      '/v1/audit-events',
      { limit: '0.5', resourceId: 'AST_1', cursor: 'bad' },
    ],
    [
      'SYSTEM_ADMIN the same, window reversed',
      '/v1/audit-events',
      { from: window.to, to: window.from, limit: '0.5', resourceId: 'AST_1', cursor: 'bad' },
    ],
    [
      'SYSTEM_ADMIN verify, with a limit it does not take',
      '/v1/audit-events/verify',
      { limit: '1e999' },
    ],
  ])('%s', async (name, path, query) => {
    const response = await request(server)
      .get(path)
      .query({ ...window, ...query })
      .set('Authorization', `Bearer ${systemAdmin()}`);

    expect(response.status).toBe(400);
    matchesZod3(name, { code: response.body.code, details: response.body.details });
  });

  it('UNION_ADMIN in its own organization: limit=1e999', async () => {
    const union = orgId('ZOD3-HTTP-UNION');
    const response = await request(server)
      .get('/v1/audit-events')
      .query({ ...window, organizationId: union, limit: '1e999' })
      .set('Authorization', `Bearer ${unionAdmin(union)}`);

    expect(response.status).toBe(400);
    matchesZod3('UNION_ADMIN limit=1e999', {
      code: response.body.code,
      details: response.body.details,
    });
  });
});
