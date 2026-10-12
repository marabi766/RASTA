import request from 'supertest';
import { runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import {
  actor,
  auditor,
  internalToken,
  person,
  startApi,
  systemAdminOf,
  type ApiHarness,
} from './api-helpers';
import {
  cleanup,
  eventsOf,
  seedDraft,
  untilSessionsWaitOnALock,
  wire,
  type Wiring,
} from './helpers';

/**
 * CON-003 PR 2 (ADR-068 § 2, Q-95 (4)): `POST /v1/contracts/{id}/cancel` — the employer ends a
 * draft, for a reason from a closed list. Only a draft; by default not one a party has signed; a
 * signed contract is ended by no route.
 */
describe('POST /v1/contracts/{id}/cancel', () => {
  let api: ApiHarness;
  let w: Wiring;
  const organizations: string[] = [];

  const key = (): string => `cancel-${ulid()}`;
  const http = (app: ApiHarness = api) => request(app.app.getHttpServer());
  const BODY = { reasonCode: 'TERMS_NOT_AGREED' };
  const cancel = (
    id: string,
    token: string | undefined,
    body: object = BODY,
    idempotencyKey = key(),
    app: ApiHarness = api,
  ) => {
    const r = http(app).post(`/v1/contracts/${id}/cancel`).set('idempotency-key', idempotencyKey);
    if (token) r.set('authorization', `Bearer ${token}`);
    return r.send(body);
  };
  const sign = (id: string, token: string, app: ApiHarness = api) =>
    http(app)
      .post(`/v1/contracts/${id}/sign`)
      .set('authorization', `Bearer ${token}`)
      .set('idempotency-key', key())
      .send({});

  const employerCanceller = (org: string) => person(org, ['ORGANIZATION_ADMIN']);
  const employerSigner = employerCanceller;
  const contractorSigner = (org: string) => person(org, ['CONTRACTOR']);

  const draft = () => seedDraft(w, organizations);
  const rowOf = (id: string) =>
    runUnscoped('the suite reads the contract', () =>
      w.prisma.client.contract.findFirstOrThrow({ where: { id } }),
    );
  const signaturesOf = (contractId: string) =>
    runUnscoped('the suite reads the signatures', () =>
      w.prisma.client.contractSignature.findMany({ where: { contractId } }),
    );
  const reasons = (body: { details?: { path: string; code: string }[] }) =>
    body.details?.map((detail) => `${detail.path}:${detail.code}`);

  beforeAll(async () => {
    api = await startApi();
    w = wire();
  });

  afterAll(async () => {
    await cleanup(organizations);
    await w.close();
    await api.close();
  });

  it('the employer cancels a draft: CANCELLED with its reason, in one transaction with CONTRACT_CANCELLED', async () => {
    const { id, employer, contractor, award } = await draft();
    const claims = { sub: `sub-${ulid()}`, rastaUserId: `USR-${ulid().slice(-8)}` };

    const res = await cancel(id, person(employer, ['ORGANIZATION_ADMIN'], claims), {
      reasonCode: 'CONTRACTOR_WITHDREW',
      note: '  The contractor withdrew in writing.  ',
    }).expect(200);

    expect(res.body).toMatchObject({
      id,
      status: 'CANCELLED',
      version: 2,
      cancelReasonCode: 'CONTRACTOR_WITHDREW',
      cancelNote: 'The contractor withdrew in writing.',
      employerSignedAt: null,
      contractorSignedAt: null,
    });
    const row = await rowOf(id);
    expect(row).toMatchObject({
      status: 'CANCELLED',
      version: 2,
      statusChangedBy: claims.rastaUserId,
      cancelReasonCode: 'CONTRACTOR_WITHDREW',
      cancelNote: 'The contractor withdrew in writing.',
    });

    const events = await eventsOf(w.prisma, employer);
    expect(events.map((e) => e.eventName)).toEqual(['CONTRACT_DRAFTED', 'CONTRACT_CANCELLED']);
    expect(events[1]!.payload).toEqual({
      contractId: id,
      tenderId: award.tenderId,
      projectId: award.projectId,
      organizationId: employer,
      contractorOrganizationId: contractor,
      reasonCode: 'CONTRACTOR_WITHDREW',
      cancelledAt: row.statusChangedAt.toISOString(),
    });
    // The code travels; the note and the amount never do.
    expect(JSON.stringify(events)).not.toContain('withdrew in writing');
    expect(JSON.stringify(events)).not.toContain(award.amountMinor);
  });

  it('both parties then read the reason, and the contractor can sign nothing any more', async () => {
    const { id, employer, contractor } = await draft();
    await cancel(id, employerCanceller(employer)).expect(200);

    for (const token of [employerCanceller(employer), contractorSigner(contractor)]) {
      const seen = await http()
        .get(`/v1/contracts/${id}`)
        .set('authorization', `Bearer ${token}`)
        .expect(200);
      expect(seen.body).toMatchObject({
        status: 'CANCELLED',
        cancelReasonCode: 'TERMS_NOT_AGREED',
      });
    }
    const refused = await sign(id, contractorSigner(contractor)).expect(422);
    expect(reasons(refused.body)).toEqual(['signature:CONTRACT_NOT_DRAFT']);
    expect(await signaturesOf(id)).toHaveLength(0);
  });

  describe('who may cancel: the employer, with a configured role, and nobody else', () => {
    it('the contractor is told 403 — it is a party and knows the contract — and nothing changes', async () => {
      const { id, contractor } = await draft();
      const res = await cancel(id, contractorSigner(contractor)).expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
      expect((await rowOf(id)).status).toBe('DRAFT');
    });

    it('a role CONTRACT_CANCEL_ROLES does not name is 403', async () => {
      const { id, employer } = await draft();
      for (const roles of [['DRIVER'], ['FLEET_MANAGER'], ['CONTRACTOR']]) {
        const res = await cancel(id, person(employer, roles)).expect(403);
        expect(res.body.code).toBe('INSUFFICIENT_ROLE');
      }
      expect((await rowOf(id)).status).toBe('DRAFT');
    });

    it('the platform administrator, the oversight role and a service never cancel — whatever else the token holds', async () => {
      const { id, employer, contractor } = await draft();
      await cancel(id, systemAdminOf(employer)).expect(403);
      await cancel(id, person(employer, ['SYSTEM_ADMIN', 'ORGANIZATION_ADMIN'])).expect(403);
      await cancel(id, auditor(employer)).expect(403);
      await cancel(id, auditor(contractor)).expect(403);
      for (const caller of ['economic-service', 'construction-service']) {
        await http()
          .post(`/v1/contracts/${id}/cancel`)
          .set('idempotency-key', key())
          .set('x-internal-token', await internalToken(caller, { organizationId: employer }))
          .send(BODY)
          .expect(403);
      }
      await cancel(id, undefined).expect(401);
      expect((await rowOf(id)).status).toBe('DRAFT');
    });

    it('a token without the platform user id cancels nothing: 403', async () => {
      const { id, employer } = await draft();
      await cancel(id, person(employer, ['ORGANIZATION_ADMIN'], { rastaUserId: undefined })).expect(
        403,
      );
      expect((await rowOf(id)).status).toBe('DRAFT');
    });

    it('another organization is told 404, identical to a contract that does not exist', async () => {
      const { id } = await draft();
      const stranger = `ORG-STRANGER-${ulid()}`;
      organizations.push(stranger);
      const missing = await cancel('CTR_does_not_exist', employerCanceller(stranger)).expect(404);
      for (const roles of [['ORGANIZATION_ADMIN'], ['CONTRACTOR'], ['DRIVER']]) {
        const res = await cancel(id, person(stranger, roles)).expect(404);
        const { correlationId: _a, timestamp: _b, path: _c, ...theirs } = res.body;
        const { correlationId: _d, timestamp: _e, path: _f, ...mine } = missing.body;
        expect(theirs).toEqual(mine);
      }
      expect((await rowOf(id)).status).toBe('DRAFT');
    });

    it('another contract’s employer cannot cancel this one', async () => {
      const a = await draft();
      const b = await draft();
      await cancel(a.id, employerCanceller(b.employer)).expect(404);
      expect((await rowOf(a.id)).status).toBe('DRAFT');
    });
  });

  describe('the reason, from a closed list, and the note, bounded', () => {
    it('a reason the configuration does not list is 422 CANCEL_REASON_NOT_ALLOWED', async () => {
      const { id, employer } = await draft();
      const res = await cancel(id, employerCanceller(employer), { reasonCode: 'BECAUSE' }).expect(
        422,
      );
      expect(reasons(res.body)).toEqual(['cancellation:CANCEL_REASON_NOT_ALLOWED']);
      expect((await rowOf(id)).status).toBe('DRAFT');
    });

    it('is 400 for a body that is not the schema: no reason, a reason that is not a code, a free field', async () => {
      const { id, employer } = await draft();
      for (const body of [
        {},
        { reasonCode: 'terms not agreed' },
        { reasonCode: 'X' },
        { reasonCode: 'OTHER', status: 'CANCELLED' },
        { reasonCode: 'OTHER', organizationId: 'ORG_x' },
        { reasonCode: 'OTHER', expectedVersion: 0 },
      ]) {
        await cancel(id, employerCanceller(employer), body).expect(400);
      }
      expect((await rowOf(id)).status).toBe('DRAFT');
    });

    it('a note is trimmed, at most 1000 characters, and carries no bidirectional control character', async () => {
      const a = await draft();
      const b = await draft();
      const c = await draft();
      const d = await draft();
      const note = (n: string) => ({ reasonCode: 'OTHER', note: n });

      await cancel(a.id, employerCanceller(a.employer), note('x'.repeat(1001))).expect(400);
      await cancel(a.id, employerCanceller(a.employer), note('   ')).expect(400);
      // U+202E RIGHT-TO-LEFT OVERRIDE: invisible, and it makes the text lie about itself.
      await cancel(a.id, employerCanceller(a.employer), note('12‮34')).expect(400);
      await cancel(a.id, employerCanceller(a.employer), note('a‏b')).expect(400);
      expect((await rowOf(a.id)).status).toBe('DRAFT');

      // The longest note, and Persian text with a ZWNJ (which is not a bidi control), are fine.
      await cancel(b.id, employerCanceller(b.employer), note('x'.repeat(1000))).expect(200);
      await cancel(c.id, employerCanceller(c.employer), note('قرارداد می‌خواهد')).expect(200);
      expect((await rowOf(c.id)).cancelNote).toBe('قرارداد می‌خواهد');
      // The note is optional.
      const plain = await cancel(d.id, employerCanceller(d.employer), {
        reasonCode: 'OTHER',
      }).expect(200);
      expect(plain.body.cancelNote).toBeNull();
    });

    it('the database holds the same bounds, whatever the code forgets', async () => {
      const { id } = await draft();
      const violation = (note: string) =>
        runUnscoped('the suite writes past the service', () =>
          w.prisma.client.$executeRawUnsafe(
            `UPDATE "contract" SET "status" = 'CANCELLED', "cancel_reason_code" = 'OTHER', "cancel_note" = $1, "version" = 2, "updated_at" = now(), "status_changed_at" = now() WHERE id = $2`,
            note,
            id,
          ),
        );
      await expect(violation('x'.repeat(1001))).rejects.toThrow(/ck_contract_cancellation/);
      await expect(violation('12‮34')).rejects.toThrow(/ck_contract_cancellation/);
      await expect(violation('   ')).rejects.toThrow(/ck_contract_cancellation/);
    });
  });

  describe('only a draft, and by default not one a party has signed', () => {
    it('a signed contract is ended by no route: 422 CONTRACT_NOT_DRAFT (termination is a legal decision, Q-95 (4))', async () => {
      const { id, employer, contractor } = await draft();
      await sign(id, employerSigner(employer)).expect(200);
      await sign(id, contractorSigner(contractor)).expect(200);

      const res = await cancel(id, employerCanceller(employer)).expect(422);
      expect(reasons(res.body)).toEqual(['cancellation:CONTRACT_NOT_DRAFT']);
      expect((await rowOf(id)).status).toBe('SIGNED');
    });

    it('a cancelled contract is not cancelled again', async () => {
      const { id, employer } = await draft();
      await cancel(id, employerCanceller(employer)).expect(200);
      const again = await cancel(id, employerCanceller(employer)).expect(422);
      expect(reasons(again.body)).toEqual(['cancellation:CONTRACT_NOT_DRAFT']);
      expect(await eventsOf(w.prisma, employer, 'CONTRACT_CANCELLED')).toHaveLength(1);
    });

    it('a draft one side has signed is not cancelled by default: 422 SIGNATURE_RECORDED (Q-95 (4), conservative)', async () => {
      for (const first of ['employer', 'contractor'] as const) {
        const { id, employer, contractor } = await draft();
        await sign(
          id,
          first === 'employer' ? employerSigner(employer) : contractorSigner(contractor),
        ).expect(200);

        const res = await cancel(id, employerCanceller(employer)).expect(422);
        expect(reasons(res.body)).toEqual(['cancellation:SIGNATURE_RECORDED']);
        expect((await rowOf(id)).status).toBe('DRAFT');
        expect(await eventsOf(w.prisma, employer, 'CONTRACT_CANCELLED')).toHaveLength(0);
      }
    });

    it('expectedVersion, when given, must be the current version: 409 OPTIMISTIC_LOCK_FAILED', async () => {
      const { id, employer } = await draft();
      const stale = await cancel(id, employerCanceller(employer), {
        ...BODY,
        expectedVersion: 5,
      }).expect(409);
      expect(stale.body.code).toBe('OPTIMISTIC_LOCK_FAILED');
      expect((await rowOf(id)).status).toBe('DRAFT');
      await cancel(id, employerCanceller(employer), { ...BODY, expectedVersion: 1 }).expect(200);
    });
  });

  describe('Idempotency-Key (docs/06 § 6.8)', () => {
    it('is required: none, too short and too long are 400, and nothing is cancelled', async () => {
      const { id, employer } = await draft();
      const token = employerCanceller(employer);
      for (const value of [undefined, '  ', 'short', 'x'.repeat(256)]) {
        const r = http().post(`/v1/contracts/${id}/cancel`).set('authorization', `Bearer ${token}`);
        if (value !== undefined) r.set('idempotency-key', value);
        const res = await r.send(BODY).expect(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
      expect((await rowOf(id)).status).toBe('DRAFT');
    });

    it('the same key, the same request and user: the first response again, and nothing done twice', async () => {
      const { id, employer } = await draft();
      const token = employerCanceller(employer);
      const k = key();
      const first = await cancel(id, token, BODY, k).expect(200);
      const replay = await cancel(id, token, BODY, k).expect(200);
      expect(replay.body).toEqual(first.body);
      expect(await eventsOf(w.prisma, employer, 'CONTRACT_CANCELLED')).toHaveLength(1);
      expect((await rowOf(id)).version).toBe(2);
    });

    it('the same key with another body or another user is 409 IDEMPOTENCY_KEY_REUSED', async () => {
      const { id, employer } = await draft();
      const token = employerCanceller(employer);
      const k = key();
      await cancel(id, token, BODY, k).expect(200);
      const otherBody = await cancel(id, token, { reasonCode: 'OTHER' }, k).expect(409);
      expect(otherBody.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      const otherUser = await cancel(id, employerCanceller(employer), BODY, k).expect(409);
      expect(otherUser.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('a refused cancellation releases its key', async () => {
      const { id, employer } = await draft();
      const k = key();
      await cancel(id, employerCanceller(employer), { reasonCode: 'BECAUSE' }, k).expect(422);
      // The same key, a corrected request: free, because the refused one left no claim.
      await cancel(id, employerCanceller(employer), BODY, k).expect(200);
    });

    it('two cancellations at once are one, and the second answers it', async () => {
      const { id, employer } = await draft();
      const token = employerCanceller(employer);
      const k = key();
      const [one, two] = await Promise.all([
        cancel(id, token, BODY, k),
        cancel(id, token, BODY, k),
      ]);
      expect([one.status, two.status]).toEqual([200, 200]);
      expect(one.body).toEqual(two.body);
      expect(await eventsOf(w.prisma, employer, 'CONTRACT_CANCELLED')).toHaveLength(1);
    });
  });

  describe('concurrency: a cancellation and a signature are ordered by the contract’s row lock', () => {
    it('cancelling while the contractor signs: one wins, the other is refused, and the contract is coherent', async () => {
      const { id, employer, contractor } = await draft();

      let release!: () => void;
      let locked!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      const gotLock = new Promise<void>((resolve) => (locked = resolve));
      const holder = w.prisma.transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM contract WHERE id = ${id} FOR UPDATE`;
          locked();
          await released;
        },
        { timeoutMs: 60_000 },
      );
      await gotLock;

      const both = Promise.all([
        cancel(id, employerCanceller(employer)),
        sign(id, contractorSigner(contractor)),
      ]);
      try {
        await untilSessionsWaitOnALock(w.prisma, 2);
      } finally {
        // A failed wait must not leave the row lock held for the tests after this one.
        release();
        await Promise.allSettled([holder, both]);
      }
      await holder;
      const [cancelled, signed] = await both;

      const row = await rowOf(id);
      const signatures = await signaturesOf(id);
      if (row.status === 'CANCELLED') {
        // The cancellation ran first: the contractor's signature found no draft.
        expect([cancelled.status, signed.status]).toEqual([200, 422]);
        expect(signatures).toHaveLength(0);
        expect(reasons(signed.body)).toEqual(['signature:CONTRACT_NOT_DRAFT']);
      } else {
        // The signature ran first: the cancellation found a signed draft.
        expect([cancelled.status, signed.status]).toEqual([422, 200]);
        expect(row.status).toBe('DRAFT');
        expect(signatures).toHaveLength(1);
        expect(reasons(cancelled.body)).toEqual(['cancellation:SIGNATURE_RECORDED']);
      }
      // Never a cancelled contract with a signature, and never both events.
      const names = (await eventsOf(w.prisma, employer)).map((e) => e.eventName);
      expect(names.filter((n) => n === 'CONTRACT_CANCELLED').length).toBe(
        row.status === 'CANCELLED' ? 1 : 0,
      );
    });
  });

  describe('configuration', () => {
    it('with no cancel roles configured nobody cancels: 403', async () => {
      const none = await startApi({ CONTRACT_CANCEL_ROLES: '' });
      try {
        const { id, employer } = await draft();
        const res = await cancel(
          id,
          actor(employer, ['ORGANIZATION_ADMIN']),
          BODY,
          key(),
          none,
        ).expect(403);
        expect(res.body.code).toBe('INSUFFICIENT_ROLE');
        expect((await rowOf(id)).status).toBe('DRAFT');
      } finally {
        await none.close();
      }
    });

    it('a client who allows it can cancel a draft a party has signed — and the contractor can then sign nothing', async () => {
      const lenient = await startApi({
        CONTRACT_CANCEL_AFTER_SIGNATURE: 'true',
        CONTRACT_CANCEL_REASON_CODES: 'TERMS_CHANGED,OTHER',
      });
      try {
        const { id, employer, contractor } = await draft();
        await sign(id, contractorSigner(contractor), lenient).expect(200);

        // The configured list is the closed list: the default one's reason is no longer allowed.
        await cancel(id, employerCanceller(employer), BODY, key(), lenient).expect(422);
        const res = await cancel(
          id,
          employerCanceller(employer),
          { reasonCode: 'TERMS_CHANGED' },
          key(),
          lenient,
        ).expect(200);
        expect(res.body).toMatchObject({ status: 'CANCELLED', cancelReasonCode: 'TERMS_CHANGED' });
        // The signature stays on record: the audit trail is never erased by a cancellation.
        expect(res.body.contractorSignedAt).toEqual(expect.any(String));
        expect(await signaturesOf(id)).toHaveLength(1);

        const late = await sign(id, employerSigner(employer), lenient).expect(422);
        expect(reasons(late.body)).toEqual(['signature:CONTRACT_NOT_DRAFT']);
      } finally {
        await lenient.close();
      }
    });
  });
});
