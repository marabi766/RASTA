import { createPublicKey, createPrivateKey } from 'node:crypto';
import request from 'supertest';
import { rfqIssuedPayloadSchema } from '@rasta/contracts';
import { DemandRepository } from '../src/demand/demand.repository';
import { EnvKekProvider } from '../src/rfq/key-provider';
import { RfqRepository } from '../src/rfq/rfq.repository';
import { criteriaDigest } from '../src/rfq/dto';
import { actor, buyer, client, internalToken, key } from './api-helpers';
import {
  AFTER_READY,
  barrier,
  startRfqApi,
  waitForLockWaiter,
  type RfqHarness,
} from './rfq-helpers';

/**
 * Issuing an RFQ from a READY aggregation (ADR-070 § 3, plan PR 6): a human command, in one
 * transaction with the aggregation's READY → RFQ_ISSUED and RFQ_ISSUED; every invitee asked of
 * supplier-service first, fail closed; a sealing key wrapped by the RFQ KEK; the preconditions
 * judged again under the aggregation's lock, and a precondition another command broke answered 409
 * in every interleaving.
 */
describe('issuing an RFQ', () => {
  let h: RfqHarness;

  beforeAll(async () => {
    h = await startRfqApi();
  });

  afterAll(async () => {
    await h.close();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const rfqRows = (aggregationId: string) =>
    h.api.prisma.client.$queryRaw<{ id: string }[]>`
      SELECT id FROM rfq WHERE aggregation_id = ${aggregationId}`;

  /** Nothing of an issue was written: the aggregation as it was, no RFQ, no event. */
  async function nothingIssued(
    organizationId: string,
    aggregation: { id: string; version: number },
  ) {
    const read = (await client(h.api, buyer(organizationId)).aggregation(aggregation.id)).body;
    expect(read).toMatchObject({ status: 'READY', version: aggregation.version, rfqId: null });
    expect(await rfqRows(aggregation.id)).toEqual([]);
    expect(await h.events(organizationId, 'RFQ_ISSUED')).toEqual([]);
  }

  it('READY → RFQ_ISSUED and a PUBLISHED RFQ at once: frozen criteria, explicit invitations, a wrapped key, one event naming the criteria by digest', async () => {
    const { organizationId, aggregation } = await h.readyAggregation();
    const body = h.issueBody(aggregation, { procurementNature: 'RFP' });
    const asked = h.supplier.asked.length;

    const issued = await h.admin(organizationId, 'USR-ISSUER').issueRfq(aggregation.id, body);

    expect(issued.status).toBe(201);
    const invitees = [...body.invitedSupplierOrganizationIds].sort();
    expect(issued.body).toEqual({
      id: expect.stringMatching(/^RFQ_[0-9A-Z]{26}$/),
      organizationId,
      aggregationId: aggregation.id,
      productId: aggregation.productId,
      totalQuantity: 5,
      status: 'PUBLISHED',
      procurementNature: 'RFP',
      quotationClosingAt: body.quotationClosingAt,
      criteria: body.criteria,
      criteriaDigest: criteriaDigest(body.criteria as never),
      invitedSupplierOrganizationIds: invitees,
      issuedAt: AFTER_READY.toISOString(),
      closedAt: null,
      cancelledAt: null,
      cancelReasonCode: null,
      cancelReason: null,
      version: 1,
    });
    // Every invitee asked of supplier-service, with a tenant-less service token, never a bearer.
    const calls = h.supplier.asked.slice(asked);
    expect(calls.map((call) => call.organizationId).sort()).toEqual(invitees);
    for (const call of calls) {
      expect(call.authorization).toBeUndefined();
      expect(call.internalToken).toEqual(expect.any(String));
    }

    const after = (await client(h.api, buyer(organizationId)).aggregation(aggregation.id)).body;
    expect(after).toMatchObject({
      status: 'RFQ_ISSUED',
      rfqId: issued.body.id,
      version: aggregation.version + 1,
    });

    const [event, ...more] = await h.events(organizationId, 'RFQ_ISSUED');
    expect(more).toEqual([]);
    expect(rfqIssuedPayloadSchema.parse(event)).toEqual({
      rfqId: issued.body.id,
      organizationId,
      aggregationId: aggregation.id,
      rfqVersion: 1,
      productId: aggregation.productId,
      totalQuantity: 5,
      procurementNature: 'RFP',
      quotationClosingAt: body.quotationClosingAt,
      invitedSupplierOrganizationIds: body.invitedSupplierOrganizationIds,
      criteriaCount: 2,
      criteriaDigest: issued.body.criteriaDigest,
      keyId: expect.stringMatching(/^RFK_/),
      issuedBy: 'USR-ISSUER',
      issuedAt: AFTER_READY.toISOString(),
    });
    expect(JSON.stringify(event)).not.toContain('Unit price');

    // The key: the public half in the clear, the private half only wrapped — and the KEK of this
    // run unwraps exactly the private key of that public key.
    const [row] = await h.api.prisma.client.$queryRaw<
      {
        key_id: string;
        public_key_pem: string;
        kek_id: string;
        wrap_nonce: Buffer;
        wrapped_private_key: Buffer;
        wrap_tag: Buffer;
      }[]
    >`SELECT key_id, public_key_pem, kek_id, wrap_nonce, wrapped_private_key, wrap_tag
        FROM rfq WHERE id = ${issued.body.id as string}`;
    const der = new EnvKekProvider(
      h.kek.PROCUREMENT_RFQ_KEKS,
      h.kek.PROCUREMENT_RFQ_KEK_CURRENT,
    ).unwrap(
      {
        kekId: row!.kek_id,
        nonce: Buffer.from(row!.wrap_nonce),
        ciphertext: Buffer.from(row!.wrapped_private_key),
        tag: Buffer.from(row!.wrap_tag),
      },
      { rfqId: issued.body.id as string, keyId: row!.key_id },
    );
    const derived = createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }));
    expect(derived.export({ type: 'spki', format: 'pem' })).toBe(row!.public_key_pem);
    expect(Buffer.from(row!.wrapped_private_key).includes(der.subarray(0, 32))).toBe(false);
  });

  it('is idempotent under its key: the same request answers the same RFQ and issues nothing again; another body is 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const { organizationId, aggregation } = await h.readyAggregation();
    const admin = h.admin(organizationId);
    const body = h.issueBody(aggregation);
    const k = key();

    const first = await admin.issueRfq(aggregation.id, body, k);
    const replay = await admin.issueRfq(aggregation.id, body, k);
    const reused = await admin.issueRfq(aggregation.id, { ...body, procurementNature: 'RFP' }, k);

    expect([first.status, replay.status, reused.status]).toEqual([201, 201, 409]);
    expect(replay.body).toEqual(first.body);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await rfqRows(aggregation.id)).toHaveLength(1);
    expect(await h.events(organizationId, 'RFQ_ISSUED')).toHaveLength(1);
  });

  it.each([
    [
      'without procurementNature (required, no default: ADR-023, Q-03)',
      { procurementNature: undefined },
    ],
    ['with a procurementNature outside the closed set', { procurementNature: 'AUCTION' }],
    [
      'with weights that do not sum to 10000',
      {
        criteria: [
          { code: 'A', label: 'A', weightBp: 9999, scoringMethod: 'MANUAL_SCORE', maxScore: 10 },
        ],
      },
    ],
    [
      'with a PASS_FAIL criterion scored above 1',
      {
        criteria: [
          { code: 'A', label: 'A', weightBp: 10000, scoringMethod: 'PASS_FAIL', maxScore: 2 },
        ],
      },
    ],
    ['with no invitee', { invitedSupplierOrganizationIds: [] }],
    [
      'with an invitee twice',
      {
        invitedSupplierOrganizationIds: [
          'ORG_01JABCDEFGHJKMNPQRSTVWXYZ0',
          'ORG_01JABCDEFGHJKMNPQRSTVWXYZ0',
        ],
      },
    ],
    ['with a deadline that is not UTC', { quotationClosingAt: '2031-03-05T08:00:00+03:30' }],
  ])('refuses an issue %s: 400, nothing written, nobody asked', async (_label, overrides) => {
    const { organizationId, aggregation } = await h.readyAggregation();
    const asked = h.supplier.asked.length;

    const refused = await h
      .admin(organizationId)
      .issueRfq(aggregation.id, h.issueBody(aggregation, overrides));

    expect(refused.status).toBe(400);
    expect(h.supplier.asked.length).toBe(asked);
    await nothingIssued(organizationId, aggregation);
  });

  it.each([
    ['suspended now', 'SUSPENDED'],
    ['qualified to build only (CONTRACTING), not to supply goods', 'CONTRACTING_ONLY'],
    ['unknown to supplier-service (no approval)', undefined],
  ] as const)(
    'refuses an invitee %s: 422 INVITEE_NOT_ELIGIBLE, nothing written',
    async (_label, standing) => {
      const { organizationId, aggregation } = await h.readyAggregation();
      const body = h.issueBody(aggregation);
      const ineligible = standing
        ? h.supplier.organization(standing)
        : 'ORG_01JZZZZZZZZZZZZZZZZZZZZZZZ';
      body.invitedSupplierOrganizationIds.push(ineligible);

      const refused = await h.admin(organizationId).issueRfq(aggregation.id, body);

      expect(refused.status).toBe(422);
      expect(refused.body.details).toEqual([
        { path: 'rfqIssue', code: 'INVITEE_NOT_ELIGIBLE', message: expect.any(String) },
      ]);
      expect(JSON.stringify(refused.body)).not.toContain(ineligible);
      await nothingIssued(organizationId, aggregation);
    },
  );

  it.each([
    ['answering 500', 'DOWN', 503, 'UPSTREAM_UNAVAILABLE'],
    ['answering about another organization', 'SOMEONE_ELSE', 503, 'UPSTREAM_UNAVAILABLE'],
    ['answering after PROCUREMENT_SUPPLIER_REQUEST_TIMEOUT_MS', 'SLOW', 504, 'UPSTREAM_TIMEOUT'],
  ] as const)(
    'fails closed when supplier-service is %s: %s, no row, no event',
    async (_label, standing, status, code) => {
      const { organizationId, aggregation } = await h.readyAggregation();
      const body = h.issueBody(aggregation);
      body.invitedSupplierOrganizationIds.push(h.supplier.organization(standing));

      const refused = await h.admin(organizationId).issueRfq(aggregation.id, body);

      expect({ status: refused.status, code: refused.body.code }).toEqual({ status, code });
      await nothingIssued(organizationId, aggregation);
    },
  );

  it('fails closed when supplier-service cannot be reached at all: 503, no row', async () => {
    const unreachable = await startRfqApi({ SUPPLIER_SERVICE_URL: 'http://127.0.0.1:1' });
    try {
      const { organizationId, aggregation } = await unreachable.readyAggregation();
      const refused = await unreachable
        .admin(organizationId)
        .issueRfq(aggregation.id, unreachable.issueBody(aggregation));
      expect(refused.status).toBe(503);
      expect(refused.body.code).toBe('UPSTREAM_UNAVAILABLE');
      const read = (
        await client(unreachable.api, buyer(organizationId)).aggregation(aggregation.id)
      ).body;
      expect(read).toMatchObject({ status: 'READY', rfqId: null });
    } finally {
      await unreachable.close();
    }
  });

  it('with no KEK configured, no RFQ is issued: 503, nothing written', async () => {
    const keyless = await startRfqApi({
      PROCUREMENT_RFQ_KEKS: '',
      PROCUREMENT_RFQ_KEK_CURRENT: '',
    });
    try {
      const { organizationId, aggregation } = await keyless.readyAggregation();
      const refused = await keyless
        .admin(organizationId)
        .issueRfq(aggregation.id, keyless.issueBody(aggregation));
      expect(refused.status).toBe(503);
      expect(refused.body.code).toBe('UPSTREAM_UNAVAILABLE');
      expect(await keyless.events(organizationId, 'RFQ_ISSUED')).toEqual([]);
    } finally {
      await keyless.close();
    }
  });

  it('never invites the buyer, nor more than PROCUREMENT_RFQ_MAX_INVITEES — refused before anybody is asked', async () => {
    const narrow = await startRfqApi({ PROCUREMENT_RFQ_MAX_INVITEES: '2' });
    try {
      const { organizationId, aggregation } = await narrow.readyAggregation();
      const admin = narrow.admin(organizationId);
      const asked = narrow.supplier.asked.length;

      const self = narrow.issueBody(aggregation);
      self.invitedSupplierOrganizationIds.push(organizationId);
      const buyerInvited = await admin.issueRfq(aggregation.id, self);
      const many = narrow.issueBody(aggregation);
      many.invitedSupplierOrganizationIds.push(narrow.supplier.organization());
      const tooMany = await admin.issueRfq(aggregation.id, many);

      expect([buyerInvited.status, tooMany.status]).toEqual([422, 422]);
      expect(buyerInvited.body.details[0].code).toBe('INVITEE_IS_BUYER');
      expect(tooMany.body.details[0].code).toBe('INVITEE_LIMIT_EXCEEDED');
      expect(narrow.supplier.asked.length).toBe(asked);
      // Exactly the limit is issued.
      const exactly = await admin.issueRfq(aggregation.id, narrow.issueBody(aggregation));
      expect(exactly.status).toBe(201);
    } finally {
      await narrow.close();
    }
  });

  it('the deadline must be after the database clock at the issue: exactly now is 422, one millisecond later is issued', async () => {
    const { organizationId, aggregation } = await h.readyAggregation();
    const admin = h.admin(organizationId);

    const now = await admin.issueRfq(
      aggregation.id,
      h.issueBody(aggregation, { quotationClosingAt: AFTER_READY.toISOString() }),
    );
    expect(now.status).toBe(422);
    expect(now.body.details[0].code).toBe('QUOTATION_CLOSING_NOT_IN_FUTURE');
    await nothingIssued(organizationId, aggregation);

    const later = await admin.issueRfq(
      aggregation.id,
      h.issueBody(aggregation, {
        quotationClosingAt: new Date(AFTER_READY.getTime() + 1).toISOString(),
      }),
    );
    expect(later.status).toBe(201);
    expect(later.body.quotationClosingAt).toBe(new Date(AFTER_READY.getTime() + 1).toISOString());
  });

  it('a stale version is 409; an aggregation that is not READY is 422 AGGREGATION_NOT_READY; one RFQ per aggregation', async () => {
    const { organizationId, aggregation } = await h.readyAggregation();
    const admin = h.admin(organizationId);
    const asked = h.supplier.asked.length;

    const stale = await admin.issueRfq(
      aggregation.id,
      h.issueBody({ version: aggregation.version - 1 }),
    );
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('OPTIMISTIC_LOCK_FAILED');
    // Judged before anybody is asked.
    expect(h.supplier.asked.length).toBe(asked);

    // The window that ended this one is OPEN: not READY.
    const open = (await client(h.api, buyer(organizationId)).aggregations('?status=OPEN')).body
      .items[0];
    const notReady = await admin.issueRfq(open.id, h.issueBody(open));
    expect(notReady.status).toBe(422);
    expect(notReady.body.details[0].code).toBe('AGGREGATION_NOT_READY');

    const issued = await admin.issueRfq(aggregation.id, h.issueBody(aggregation));
    expect(issued.status).toBe(201);
    const again = await admin.issueRfq(
      aggregation.id,
      h.issueBody({ version: aggregation.version + 1 }),
    );
    expect(again.status).toBe(422);
    expect(again.body.details[0].code).toBe('AGGREGATION_NOT_READY');
    expect(await rfqRows(aggregation.id)).toHaveLength(1);
  });

  it.each([
    ['PROCUREMENT_USER (docs/09: rfq:read only)', ['PROCUREMENT_USER']],
    ['SUPPLIER', ['SUPPLIER']],
    ['AUDITOR beside the issuer role', ['AUDITOR', 'ORGANIZATION_ADMIN']],
    ['SYSTEM_ADMIN beside the issuer role', ['SYSTEM_ADMIN', 'ORGANIZATION_ADMIN']],
  ])('refuses %s of the buyer’s own organization: 403, nothing written', async (_label, roles) => {
    const { organizationId, aggregation } = await h.readyAggregation();
    const refused = await client(h.api, actor(organizationId, roles)).issueRfq(
      aggregation.id,
      h.issueBody(aggregation),
    );
    expect(refused.status).toBe(403);
    await nothingIssued(organizationId, aggregation);
  });

  it('another organization’s administrator, and a missing id: the same 404; a service token: 403', async () => {
    const { organizationId, aggregation } = await h.readyAggregation();
    const stranger = h.admin(h.org());

    const theirs = await stranger.issueRfq(aggregation.id, h.issueBody(aggregation));
    const missing = await stranger.issueRfq(
      'AGG_01JAAAAAAAAAAAAAAAAAAAAAAA',
      h.issueBody(aggregation),
    );
    const service = await request(h.api.app.getHttpServer())
      .post(`/v1/aggregations/${aggregation.id}/rfq`)
      .set('x-internal-token', await internalToken('economic-service', organizationId))
      .set('idempotency-key', key())
      .send(h.issueBody(aggregation));

    expect([theirs.status, missing.status, service.status]).toEqual([404, 404, 403]);
    expect(Object.keys(theirs.body).sort()).toEqual(Object.keys(missing.body).sort());
    await nothingIssued(organizationId, aggregation);
  });

  describe('a precondition another command broke is 409, in every interleaving', () => {
    /** The first call of `method` waits at a barrier, holding whatever it holds, then goes on. */
    function parkFirst<T extends object, K extends keyof T>(target: T, method: K) {
      const gate = barrier();
      const original = (target[method] as (...args: unknown[]) => Promise<unknown>).bind(target);
      jest.spyOn(target, method as never).mockImplementationOnce((async (...args: unknown[]) => {
        gate.arrive();
        await gate.wait;
        return original(...args);
      }) as never);
      return gate;
    }

    const started = (test: request.Test) => test.then((response) => response);
    const LOCK = /FROM demand_aggregation WHERE organization_id/;

    it('two issues of one version: the one that waited on the lock finds the version moved — 409, one RFQ', async () => {
      const { organizationId, aggregation } = await h.readyAggregation();
      const admin = h.admin(organizationId);
      const gate = parkFirst(h.api.get(RfqRepository), 'insertRfq');

      const first = started(admin.issueRfq(aggregation.id, h.issueBody(aggregation)));
      await gate.reached;
      const second = started(admin.issueRfq(aggregation.id, h.issueBody(aggregation)));
      await waitForLockWaiter(h.api, LOCK);
      gate.release();

      const [a, b] = await Promise.all([first, second]);
      expect([a.status, b.status]).toEqual([201, 409]);
      expect(b.body.code).toBe('OPTIMISTIC_LOCK_FAILED');
      expect(await rfqRows(aggregation.id)).toHaveLength(1);
      expect(await h.events(organizationId, 'RFQ_ISSUED')).toHaveLength(1);
    });

    it('an issue that read the aggregation, then waited on supplier-service while another committed: 409 under the lock, nothing written by it', async () => {
      const { organizationId, aggregation } = await h.readyAggregation();
      const admin = h.admin(organizationId);
      const slowBody = h.issueBody(aggregation);
      const parked = h.supplier.park(slowBody.invitedSupplierOrganizationIds[0]!);

      const first = started(admin.issueRfq(aggregation.id, slowBody));
      await parked.reached;
      const second = await admin.issueRfq(aggregation.id, h.issueBody(aggregation));
      parked.release();

      const a = await first;
      expect([second.status, a.status]).toEqual([201, 409]);
      expect(a.body.code).toBe('OPTIMISTIC_LOCK_FAILED');
      expect(await rfqRows(aggregation.id)).toEqual([{ id: second.body.id }]);
    });

    it('an issue and an aggregation cancel, the cancel first: the issue waits on the lock, then 409', async () => {
      const { organizationId, aggregation } = await h.readyAggregation();
      const admin = h.admin(organizationId);
      const gate = parkFirst(h.api.get(DemandRepository), 'cancelWindow');

      const cancel = started(admin.cancel(aggregation.id, aggregation.version));
      await gate.reached;
      const issue = started(admin.issueRfq(aggregation.id, h.issueBody(aggregation)));
      await waitForLockWaiter(h.api, LOCK);
      gate.release();

      const [c, i] = await Promise.all([cancel, issue]);
      expect([c.status, i.status]).toEqual([200, 409]);
      expect(i.body.code).toBe('OPTIMISTIC_LOCK_FAILED');
      expect(await rfqRows(aggregation.id)).toEqual([]);
    });

    it('an issue and an aggregation cancel, the issue first: the cancel waits on the lock, then 409 — not the 422 the new status would give', async () => {
      const { organizationId, aggregation } = await h.readyAggregation();
      const admin = h.admin(organizationId);
      const gate = parkFirst(h.api.get(RfqRepository), 'insertRfq');

      const issue = started(admin.issueRfq(aggregation.id, h.issueBody(aggregation)));
      await gate.reached;
      const cancel = started(admin.cancel(aggregation.id, aggregation.version));
      await waitForLockWaiter(h.api, LOCK);
      gate.release();

      const [i, c] = await Promise.all([issue, cancel]);
      expect([i.status, c.status]).toEqual([201, 409]);
      expect(c.body.code).toBe('OPTIMISTIC_LOCK_FAILED');
      expect(await h.events(organizationId, 'AGGREGATION_CANCELLED')).toEqual([]);
    });

    it('a write path that skipped the aggregation’s lock still answers 409: the database refuses the loser, and its refusal is mapped', async () => {
      const { organizationId, aggregation } = await h.readyAggregation();
      const admin = h.admin(organizationId);
      const demands = h.api.get(DemandRepository);
      const gate = barrier();
      // The first issue reads the aggregation without FOR UPDATE, then waits while another commits.
      jest.spyOn(demands, 'lockWindow').mockImplementationOnce(async (tx, org, id) => {
        const row = await tx.demandAggregation.findFirst({ where: { organizationId: org, id } });
        gate.arrive();
        await gate.wait;
        return row;
      });

      const first = started(admin.issueRfq(aggregation.id, h.issueBody(aggregation)));
      await gate.reached;
      const second = await admin.issueRfq(aggregation.id, h.issueBody(aggregation));
      gate.release();

      const a = await first;
      expect([second.status, a.status]).toEqual([201, 409]);
      expect(a.body.code).toBe('OPTIMISTIC_LOCK_FAILED');
      expect(await rfqRows(aggregation.id)).toEqual([{ id: second.body.id }]);
    });
  });

  it('an aggregation whose RFQ was cancelled stays RFQ_ISSUED: no second RFQ (Q-121 (4))', async () => {
    const { organizationId, aggregation } = await h.readyAggregation();
    const admin = h.admin(organizationId);
    const issued = (await admin.issueRfq(aggregation.id, h.issueBody(aggregation))).body;
    expect((await admin.cancelRfq(issued.id, issued.version)).status).toBe(200);

    const read = (await client(h.api, buyer(organizationId)).aggregation(aggregation.id)).body;
    expect(read).toMatchObject({ status: 'RFQ_ISSUED', rfqId: issued.id });
    const again = await admin.issueRfq(aggregation.id, h.issueBody({ version: read.version }));
    expect(again.status).toBe(422);
    expect(again.body.details[0].code).toBe('AGGREGATION_NOT_READY');
  });
});
