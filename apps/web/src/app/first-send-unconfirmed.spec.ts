/**
 * @jest-environment node
 */

/**
 * A first send the platform answered with a `5xx` is UNCONFIRMED in every write
 * form — never "nothing changed, you can resend" (FU-189, PR-880 F2; checklist A1).
 *
 * A `5xx` is not proof that nothing was written: the answer may be built by a read
 * after the commit, and an upstream reset after the commit surfaces as `503`. The
 * writer (`server/write.ts`) decides that once, for every caller; this spec holds
 * every module of PR-880 F2's table to it through its real action and the real
 * writer. Every module is real but the session lookup and Next's redirect; `fetch`
 * is a fake gateway that answers reads by path and every write with the case's
 * answer, so "the write was sent" is the gateway being asked for it.
 *
 * And the other side, so "unconfirmed" is not simply said for everything: a send
 * that provably never left this portal (connection refused) and a refusal the
 * platform proved (a documented `4xx` under its own status) still say nothing
 * changed (`FAILED`).
 */

import { BASELINE_FIELD } from '@/lib/form-fields';
import { CSRF_FIELD } from '@/server/csrf';
import { sealAssetBaseline } from '@/server/asset-commands';
import { sealAssetLifecycleBaseline } from '@/server/asset-lifecycle-commands';
import { sealAssetRecordBaseline } from '@/server/asset-records';
import { sealAvailabilityBaseline } from '@/server/fleet-availability';
import { sealProjectBaseline } from '@/server/project-commands';
import type { WebSession } from '@/server/session';
import { SUBMISSION_FIELD, mintSubmissionId } from '@/server/submission';
import {
  readUnresolved,
  reserveUnresolved,
  settleUnresolved,
  useUnresolvedStore,
} from '@/server/unresolved-request';
import { memoryUnresolvedStore } from '@/server/unresolved-request-store';
import { actingAccessToken } from '@/test/session-token';

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const ORG = 'ORG-DEH-0001';
const SESSION = {
  subject: 'user-1',
  username: 'u',
  organizationId: ORG,
  accessToken: actingAccessToken(ORG),
  accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 600,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf-token-for-this-session',
  issuedAt: 1_900_000_000,
} satisfies WebSession;

jest.mock('@/server/current-session', () => ({
  currentSession: async () => SESSION,
  missingSessionReason: async () => 'NO_SESSION',
}));
jest.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

/* eslint-disable @typescript-eslint/no-require-imports */
const wallet = require('./wallet/actions') as typeof import('./wallet/actions');
const orders = require('./orders/[id]/actions') as typeof import('./orders/[id]/actions');
const usage = require('./usage/actions') as typeof import('./usage/actions');
const assets = require('./assets/actions') as typeof import('./assets/actions');
const asset = require('./assets/[id]/actions') as typeof import('./assets/[id]/actions');
const records =
  require('./assets/[id]/record-actions') as typeof import('./assets/[id]/record-actions');
const lifecycle =
  require('./assets/[id]/lifecycle-actions') as typeof import('./assets/[id]/lifecycle-actions');
const availability =
  require('./assets/[id]/availability-actions') as typeof import('./assets/[id]/availability-actions');
const drivers = require('./drivers/actions') as typeof import('./drivers/actions');
const driver = require('./drivers/[id]/actions') as typeof import('./drivers/[id]/actions');
const organizations =
  require('./organizations/actions') as typeof import('./organizations/actions');
const maintenance = require('./maintenance/actions') as typeof import('./maintenance/actions');
const request =
  require('./maintenance/[id]/actions') as typeof import('./maintenance/[id]/actions');
const project =
  require('./projects/[id]/project-actions') as typeof import('./projects/[id]/project-actions');
/* eslint-enable @typescript-eslint/no-require-imports */

/** Every form's state before its first post. */
const IDLE = { kind: 'IDLE' } as never;

const DISCLOSURE = '/v1/wallets/provider/disclosure';
const PROVIDER = '/v1/wallets/provider';
const ASSET_ID = 'AST_01JASSET000000000000000000';
const DRIVER_ID = 'DRV_1';
const REQUEST_ID = 'MNT_01J00000000000000000000000';
const PROJECT_ID = 'PRJ_01J00000000000000000000000';

type Answer = { status: number; body?: unknown } | Error;

/** What the fake gateway answers a read with, by path; any other read is a 404. */
let reads: Record<string, Answer> = {};
/** What it answers every write with. */
let write: Answer = { status: 503 };
/** Every write an action sent: method, path and the correlation id it carried. */
let sent: { method: string; path: string; correlationId: string | null }[] = [];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  reads = {};
  sent = [];
  // A fresh unresolved-request store for every case (PR-921 F2): a case whose send stays
  // unresolved must not hold the next case's form, whichever case runs first.
  useUnresolvedStore(memoryUnresolvedStore());
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    let answer: Answer;
    if (method === 'GET') {
      answer = reads[url.pathname] ?? { status: 404, body: { code: 'NOT_FOUND' } };
    } else {
      const correlationId = new Headers(init?.headers).get('x-correlation-id');
      sent.push({ method, path: url.pathname, correlationId });
      answer = write;
    }
    if (answer instanceof Error) throw answer;
    return new Response(answer.body === undefined ? '' : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
});

afterEach(() => {
  useUnresolvedStore();
  globalThis.fetch = originalFetch;
});

/** A form as the page drew it: this session's CSRF token and a submission id minted for it. */
function drawnForm(fields: ReadonlyArray<readonly [string, string]>): FormData {
  const form = new FormData();
  for (const [key, value] of fields) form.append(key, value);
  form.set(CSRF_FIELD, SESSION.csrfToken);
  form.set(SUBMISSION_FIELD, mintSubmissionId(SESSION));
  return form;
}
const fieldsOf = (fields: Record<string, string>) => Object.entries(fields);

interface Area {
  readonly name: string;
  /** The reads the page drew the form from, answered as they would be. */
  readonly reads?: Record<string, Answer>;
  readonly draw: () => FormData;
  readonly submit: (form: FormData) => Promise<unknown>;
  /**
   * What a send that never left this portal says: `FAILED` (it reached nothing) unless the
   * runner is stricter still and keeps it `UNCONFIRMED` — never the other way round.
   */
  readonly neverSent?: 'UNCONFIRMED';
}

const disclosed = { status: 200, body: { simulated: true } };

const AREAS: readonly Area[] = [
  {
    name: 'wallet top-up (wallet/actions.ts)',
    reads: {
      [PROVIDER]: {
        status: 200,
        body: { provider: 'mock', simulated: true, notice: 'Simulated payment provider.' },
      },
    },
    draw: () => drawnForm([['amountMinor', '1000000']]),
    submit: (form) => wallet.submitTopUp('WLT_1', IDLE, form),
  },
  {
    name: 'order CONFIRM_RECEIPT (orders/[id]/actions.ts)',
    reads: { [DISCLOSURE]: disclosed },
    draw: () =>
      drawnForm([
        ['command', 'CONFIRM_RECEIPT'],
        ['acknowledge', 'yes'],
      ]),
    submit: (form) => orders.submitOrderCommand('ORD_1', IDLE, form),
  },
  {
    name: 'usage record (usage/actions.ts)',
    reads: { [DISCLOSURE]: disclosed },
    draw: () =>
      drawnForm(
        fieldsOf({
          assetId: ASSET_ID,
          periodStart: '2026-09-21T08:00',
          periodEnd: '2026-09-21T16:30',
          hours: '8.5',
        }),
      ),
    submit: (form) => usage.submitUsage(IDLE, form),
  },
  {
    name: 'register an asset (assets/actions.ts)',
    draw: () => drawnForm(fieldsOf({ name: 'لودر کوماتسو', type: 'LOADER' })),
    submit: (form) => assets.submitRegisterAsset(IDLE, form),
  },
  {
    name: 'edit an asset (assets/[id]/actions.ts)',
    draw: () => {
      const shown = {
        name: 'لودر کوماتسو',
        assetTag: 'AB-12',
        manufacturer: '',
        model: '',
        manufactureYear: '2019',
      };
      const form = drawnForm(fieldsOf({ ...shown, assetTag: 'AB-13' }));
      form.set(BASELINE_FIELD, sealAssetBaseline(SESSION, ASSET_ID, 5, shown));
      return form;
    },
    submit: (form) => asset.submitUpdateAsset(ASSET_ID, IDLE, form),
  },
  {
    name: 'record an inspection (assets/[id]/record-runner.ts)',
    draw: () => {
      const form = drawnForm(
        fieldsOf({
          certificateNo: 'INSP-4471',
          centerName: 'مرکز معاینه فنی شمال',
          inspectedAt: '2026-09-20',
          validTo: '2027-09-20',
          result: 'PASSED',
          notes: '',
        }),
      );
      form.set(
        BASELINE_FIELD,
        sealAssetRecordBaseline(SESSION, { assetId: ASSET_ID, record: 'inspection' }),
      );
      return form;
    },
    submit: (form) => records.submitRecordInspection(ASSET_ID, IDLE, form),
  },
  {
    name: 'change an asset’s status (assets/[id]/lifecycle-runner.ts)',
    draw: () => {
      const form = drawnForm(fieldsOf({ status: 'IDLE', reason: 'فصل غیرکاری' }));
      form.set(
        BASELINE_FIELD,
        sealAssetLifecycleBaseline(SESSION, {
          assetId: ASSET_ID,
          command: 'status',
          version: 4,
          status: 'ACTIVE',
          assetName: 'لودر کوماتسو',
        }),
      );
      return form;
    },
    submit: (form) => lifecycle.submitChangeStatus(ASSET_ID, IDLE, form),
  },
  {
    name: 'declare availability (assets/[id]/availability-runner.ts)',
    draw: () => {
      const form = drawnForm(
        fieldsOf({ available: 'false', reason: 'رزرو برای پروژهٔ راه‌سازی', fromAt: '', toAt: '' }),
      );
      form.set(
        BASELINE_FIELD,
        sealAvailabilityBaseline(SESSION, { assetId: ASSET_ID, command: 'declare' }),
      );
      return form;
    },
    submit: (form) => availability.submitDeclareAvailability(ASSET_ID, IDLE, form),
  },
  {
    name: 'register a driver (drivers/actions.ts)',
    draw: () => drawnForm([['userId', 'USR_01J00000000000000000000000']]),
    submit: (form) => drivers.submitCreateDriver(IDLE, form),
  },
  {
    name: 'change a driver’s status (drivers/[id]/actions.ts)',
    draw: () => drawnForm(fieldsOf({ status: 'SUSPENDED', reason: 'بازبینی مدارک' })),
    submit: (form) => driver.submitChangeStatus(DRIVER_ID, IDLE, form),
  },
  {
    name: 'edit the organization (organizations/actions.ts)',
    draw: () =>
      drawnForm(
        fieldsOf({ organizationId: ORG, name: 'نام تازه', shortName: '', externalCode: '' }),
      ),
    submit: (form) => organizations.submitUpdateOrganization(IDLE, form),
  },
  {
    name: 'change a member’s roles (organizations/actions.ts)',
    draw: () =>
      drawnForm([
        ['membershipId', 'MBR_2'],
        ['roles', 'FLEET_MANAGER'],
        ['reason', 'جابه‌جایی مسئولیت'],
      ]),
    submit: (form) => organizations.submitUpdateMemberRoles(IDLE, form),
  },
  {
    name: 'revoke a membership (organizations/actions.ts)',
    draw: () =>
      drawnForm([
        ['membershipId', 'MBR_2'],
        ['reason', 'پایان همکاری'],
      ]),
    submit: (form) => organizations.submitRevokeMembership(IDLE, form),
  },
  {
    name: 'report a maintenance request (maintenance/actions.ts)',
    draw: () =>
      drawnForm(
        fieldsOf({
          assetId: ASSET_ID,
          type: 'CORRECTIVE',
          title: 'نشتی روغن هیدرولیک',
          severity: 'HIGH',
        }),
      ),
    submit: (form) => maintenance.submitReportRequest(IDLE, form),
  },
  {
    name: 'cancel a maintenance request (maintenance/[id]/command-runner.ts)',
    draw: () => drawnForm(fieldsOf({ requestId: REQUEST_ID, reason: 'ماشین فروخته شد' })),
    submit: (form) => request.submitCancelRequest(IDLE, form),
  },
  {
    // Already held this rule before FU-189 (its runner checks the proof itself, and keeps even a
    // send that never left UNCONFIRMED): the control, which passes on the base too.
    name: 'start a project (projects/[id]/project-runner.ts)',
    neverSent: 'UNCONFIRMED',
    draw: () => {
      const form = drawnForm([]);
      form.set(
        BASELINE_FIELD,
        sealProjectBaseline(SESSION, {
          targetId: PROJECT_ID,
          projectId: PROJECT_ID,
          command: 'start',
          version: 3,
          status: 'APPROVED',
          digests: null,
        }),
      );
      return form;
    },
    submit: (form) => project.submitStartProject(PROJECT_ID, 'project', IDLE, form),
  },
];

/** Submits once, as a first send, and checks the write itself was sent — once. */
async function firstSend(area: Area, answer: Answer): Promise<unknown> {
  reads = { ...(area.reads ?? {}) };
  write = answer;
  const state = await area.submit(area.draw());
  expect(sent).toHaveLength(1);
  return state;
}

const socket = (code: string) => new TypeError('fetch failed', { cause: { code } });

describe.each(AREAS)('$name', (area) => {
  it.each<[string, () => Answer]>([
    ['answered 500', () => ({ status: 500 })],
    ['answered 502', () => ({ status: 502 })],
    ['answered 503', () => ({ status: 503 })],
    ['cut by a connection reset', () => socket('ECONNRESET')],
    [
      'past this portal’s deadline',
      () => new DOMException('The operation timed out.', 'TimeoutError'),
    ],
  ])(
    'a first send %s is UNCONFIRMED under its own correlation id — never FAILED',
    async (_label, answer) => {
      const state = await firstSend(area, answer());
      expect(state).toEqual(
        expect.objectContaining({ kind: 'UNCONFIRMED', correlationId: sent[0]!.correlationId }),
      );
    },
  );

  it('a first send that provably never left this portal (connection refused) is FAILED', async () => {
    const state = await firstSend(area, socket('ECONNREFUSED'));
    expect(state).toEqual(expect.objectContaining({ kind: area.neverSent ?? 'FAILED' }));
  });

  it('a refusal the platform proved (429 RATE_LIMIT_EXCEEDED) is FAILED', async () => {
    const state = await firstSend(area, {
      status: 429,
      body: { code: 'RATE_LIMIT_EXCEEDED', message: 'slow down' },
    });
    expect(state).toEqual(expect.objectContaining({ kind: 'FAILED', status: 429 }));
  });
});

describe('every case starts with nothing held (PR-921 F2)', () => {
  const scope = { purpose: 'supplier-write', target: 'PR-921-F2' };

  it('a case may leave a request unresolved …', async () => {
    const reserved = await reserveUnresolved(SESSION, scope, {
      key: mintSubmissionId(SESSION),
      digest: 'd'.repeat(64),
      ref: null,
      issuedAt: Date.now(),
      deadline: null,
      windowMs: null,
    });
    if (reserved.kind !== 'RESERVED') throw new Error(`not reserved: ${reserved.kind}`);
    await settleUnresolved(reserved.attempt, 'UNRESOLVED');
    expect((await readUnresolved(SESSION, scope)).kind).toBe('PENDING');
  });

  it('… and the next case does not see it', async () => {
    expect((await readUnresolved(SESSION, scope)).kind).toBe('NONE');
  });
});
