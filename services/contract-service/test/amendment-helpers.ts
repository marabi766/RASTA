import request from 'supertest';
import { runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { person, type ApiHarness } from './api-helpers';
import { seedDraft, type AwardFixture, type Wiring } from './helpers';

/**
 * Scaffolding for the amendment and milestone suites (CON-003 PR 3): a contract that is already
 * SIGNED — made the way production makes one, through the API, by two different people — and the
 * thin request helpers the suites share.
 */

export interface SignedContract {
  readonly id: string;
  readonly employer: string;
  readonly contractor: string;
  readonly award: AwardFixture;
  /** The people who signed the contract: the employer's administrator and the contractor. */
  readonly employerToken: string;
  readonly contractorToken: string;
}

export const http = (api: ApiHarness) => request(api.app.getHttpServer());

export const idemKey = (prefix: string): string => `${prefix}-${ulid()}`;

/** A signed contract: a draft the consumer made, both parties having signed it over the API. */
export async function seedSigned(
  api: ApiHarness,
  w: Wiring,
  organizations: string[],
  overrides: Partial<AwardFixture> = {},
): Promise<SignedContract> {
  const draft = await seedDraft(w, organizations, overrides);
  const employerToken = person(draft.employer, ['ORGANIZATION_ADMIN']);
  const contractorToken = person(draft.contractor, ['CONTRACTOR']);
  for (const token of [employerToken, contractorToken]) {
    await http(api)
      .post(`/v1/contracts/${draft.id}/sign`)
      .set('authorization', `Bearer ${token}`)
      .set('idempotency-key', idemKey('seed-sign'))
      .send({})
      .expect(200);
  }
  return { ...draft, employerToken, contractorToken };
}

export const proposeBody = (overrides: Record<string, unknown> = {}) => ({
  deltaMinor: '250000000',
  reasonCode: 'SCOPE_CHANGE',
  reasonText: 'Additional pile work agreed on site',
  ...overrides,
});

export const propose = (
  api: ApiHarness,
  contractId: string,
  token: string | undefined,
  body: object = proposeBody(),
  key: string = idemKey('amd'),
) => {
  const r = http(api).post(`/v1/contracts/${contractId}/amendments`).set('idempotency-key', key);
  if (token) r.set('authorization', `Bearer ${token}`);
  return r.send(body);
};

export const signAmendment = (
  api: ApiHarness,
  contractId: string,
  amendmentId: string,
  token: string | undefined,
  body: object = {},
  key: string = idemKey('amd-sign'),
) => {
  const r = http(api)
    .post(`/v1/contracts/${contractId}/amendments/${amendmentId}/sign`)
    .set('idempotency-key', key);
  if (token) r.set('authorization', `Bearer ${token}`);
  return r.send(body);
};

export const reasons = (body: { details?: { path: string; code: string }[] }) =>
  body.details?.map((detail) => `${detail.path}:${detail.code}`);

export const contractRow = (w: Wiring, id: string) =>
  runUnscoped('the suite reads the contract', () =>
    w.prisma.client.contract.findFirstOrThrow({ where: { id } }),
  );

export const amendmentRows = (w: Wiring, contractId: string) =>
  runUnscoped('the suite reads the amendments', () =>
    w.prisma.client.amendment.findMany({
      where: { contractId },
      orderBy: { amendmentNumber: 'asc' },
    }),
  );

export const amendmentSignatures = (w: Wiring, amendmentId: string) =>
  runUnscoped('the suite reads the amendment signatures', () =>
    w.prisma.client.amendmentSignature.findMany({
      where: { amendmentId },
      orderBy: { signedAt: 'asc' },
    }),
  );

export const milestoneRows = (w: Wiring, contractId: string) =>
  runUnscoped('the suite reads the milestones', () =>
    w.prisma.client.milestone.findMany({ where: { contractId }, orderBy: { id: 'asc' } }),
  );

/** Without the envelope's per-request fields, so two refusals can be compared. */
export const bare = (body: Record<string, unknown>) => {
  const { correlationId: _c, timestamp: _t, path: _p, ...rest } = body;
  return rest;
};
