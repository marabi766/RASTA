import request from 'supertest';
import {
  quotationRevisedPayloadSchema,
  quotationSubmittedPayloadSchema,
  quotationWithdrawnPayloadSchema,
  rfqClosedPayloadSchema,
} from '@rasta/contracts';
import { expectNotDisclosed } from '@rasta/testing';
import { EventPublisher } from '../src/events/publisher';
import { LOGGER } from '../src/tokens';
import { QUOTATION_SEALING } from '../src/quotation/sealing';
import { QuotationRepository } from '../src/quotation/quotation.repository';
import { QUOTATION_BODY_MAX_BYTES } from '../src/quotation/dto';
import { JSON_BODY_LIMIT_BYTES } from '../src/shared/body-parser';
import { actor, internalToken, key } from './api-helpers';
import { cleanup } from './helpers';
import {
  AFTER_READY,
  HOUR,
  T0,
  barrier,
  startRfqApi,
  waitForLockWaiter,
  type RfqHarness,
} from './rfq-helpers';
import { CRITERION_CODES, largestQuotationBody, quotationBodyOfBytes } from './quotation-body';

/**
 * Sealed quotations on an issued RFQ (ADR-070 § 4, ADR-066 § 2-3; plan PR 8): an invited supplier
 * submits, revises and withdraws its one quotation before the deadline — the RFQ share-locked, the
 * database clock read after the lock, the database judging again on its own clock — and is given a
 * receipt that continues the RFQ's chain from the genesis audit-service recomputes. The amount is
 * bounded before anything is sealed; nobody else reaches an RFQ through this door; and nothing
 * sealed — price, answer, note — reaches an event, a log or the idempotency store.
 */
describe('sealed quotations', () => {
  let h: RfqHarness;
  const suppliers: string[] = [];

  beforeAll(async () => {
    h = await startRfqApi({ PROCUREMENT_QUOTATION_MAX_REVISIONS: '3' });
  });

  afterAll(async () => {
    await cleanup(suppliers);
    await h.close();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    h.clock.set(null);
  });

  /** The RFQ's two criteria answered, and a price. */
  const content = (unitPriceMinor = '1250000', extra: Record<string, unknown> = {}) => ({
    unitPriceMinor,
    answers: [
      { criterionCode: 'PRICE', answer: 'delivered to site' },
      { criterionCode: 'ISO', answer: 'certified' },
    ],
    ...extra,
  });

  /** A person of `organizationId` with the supplier role (the default PROCUREMENT_SUPPLIER_ROLES). */
  const supplierAs = (organizationId: string, roles = ['SUPPLIER'], rastaUserId?: string) => {
    const token = actor(organizationId, roles, rastaUserId ? { rastaUserId } : {});
    const http = () => request(h.api.app.getHttpServer());
    return {
      /** A string is sent as it is: the bytes on the wire are the test's. */
      put: (rfqId: string, body: object | string, k = key()) =>
        http()
          .put(`/v1/rfqs/${rfqId}/quotations/mine`)
          .set('authorization', `Bearer ${token}`)
          .set('idempotency-key', k)
          .type('json')
          .send(body),
      withdraw: (rfqId: string, expectedRevision: number, k = key()) =>
        http()
          .post(`/v1/rfqs/${rfqId}/quotations/mine/withdraw`)
          .set('authorization', `Bearer ${token}`)
          .set('idempotency-key', k)
          .send({ expectedRevision }),
    };
  };

  /**
   * An RFQ issued 12 hours into the timeline `t0` with a deadline `hours` later, its invitees
   * eligible suppliers (one more invited when `invite` names it).
   */
  async function issued(
    options: {
      t0?: Date;
      deadline?: Date;
      invite?: string[];
      criteria?: Record<string, unknown>[];
    } = {},
  ) {
    const t0 = options.t0 ?? T0;
    const { organizationId, aggregation } = await h.readyAggregation(undefined, t0);
    const deadline = options.deadline ?? new Date(t0.getTime() + 12 * HOUR + 48 * HOUR);
    const invitees = [
      h.supplier.organization(),
      h.supplier.organization(),
      ...(options.invite ?? []),
    ];
    suppliers.push(...invitees);
    const body = h.issueBody(aggregation, {
      quotationClosingAt: deadline.toISOString(),
      invitedSupplierOrganizationIds: invitees,
      ...(options.criteria ? { criteria: options.criteria } : {}),
    });
    const response = await h.admin(organizationId).issueRfq(aggregation.id, body);
    expect(response.status).toBe(201);
    return {
      buyer: organizationId,
      rfq: response.body as { id: string; totalQuantity: number },
      deadline,
      invitees,
    };
  }

  /** The database's clock now — the one `ck_quotation_window` and `ck_rfq_deadline` judge on. */
  const dbNow = async () =>
    (await h.api.prisma.client.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0]!.now;

  /** An RFQ whose deadline is `seconds` from now on the database clock (the service clock unpinned). */
  async function issuedForReal(seconds: number) {
    const now = await dbNow();
    const issue = await issued({
      t0: new Date(now.getTime() - 13 * HOUR),
      deadline: new Date(now.getTime() + seconds * 1000),
    });
    h.clock.set(null);
    return issue;
  }

  /** Resolves once the database clock has reached `at`: a condition, not a sleep of a guessed length. */
  async function untilDatabaseClockReaches(at: Date): Promise<void> {
    while ((await dbNow()).getTime() < at.getTime()) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  const rows = (rfqId: string) =>
    h.api.prisma.client.$queryRaw<
      { id: string; status: string; revision: number; supplier_organization_id: string }[]
    >`SELECT id, status, revision, supplier_organization_id FROM quotation WHERE rfq_id = ${rfqId} ORDER BY id`;

  const links = (rfqId: string) =>
    h.api.prisma.client.$queryRaw<
      {
        seq: number;
        quotation_id: string;
        revision: number;
        previous_receipt: string;
        receipt: string;
        eligible_as_of: Date;
      }[]
    >`SELECT seq, quotation_id, revision, previous_receipt, receipt, eligible_as_of
        FROM quotation_receipt WHERE rfq_id = ${rfqId} ORDER BY seq`;

  /** Sends a request now: a supertest request is lazy until something awaits it. */
  const started = (test: request.Test) => test.then((response) => response);

  const codeOf = (response: request.Response) =>
    (response.body as { details?: { code: string }[] }).details?.[0]?.code;

  describe('submit, revise, withdraw', () => {
    it('seals the first quotation and answers its receipt: the chain starts at the genesis audit-service recomputes, the event carries digests only', async () => {
      const { buyer, rfq, invitees } = await issued();
      h.clock.set(new Date(AFTER_READY.getTime() + HOUR));
      const response = await supplierAs(invitees[0]!).put(rfq.id, { content: content() });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        quotationId: expect.stringMatching(/^QOT_[0-9A-HJKMNP-TV-Z]{26}$/),
        rfqId: rfq.id,
        status: 'SUBMITTED',
        revision: 1,
        receivedAt: new Date(AFTER_READY.getTime() + HOUR).toISOString(),
        contentCommitment: expect.stringMatching(/^[0-9a-f]{64}$/),
        receipt: expect.stringMatching(/^[0-9a-f]{64}$/),
        withdrawnAt: null,
      });
      const [link] = await links(rfq.id);
      expect(link).toMatchObject({ seq: 1, revision: 1, receipt: response.body.receipt });
      // The service's genesis, which the database's guard recomputed to admit the link, and which
      // audit-service recomputes (the label pinned in rfq-evidence.spec.ts).
      expect(link!.previous_receipt).toBe(QUOTATION_SEALING.genesisReceipt(rfq.id));
      // The standing supplier-service answered with, kept with the link.
      expect(link!.eligible_as_of).toBeInstanceOf(Date);

      const [event] = await h.events(buyer, 'QUOTATION_SUBMITTED');
      expect(quotationSubmittedPayloadSchema.parse(event)).toEqual({
        rfqId: rfq.id,
        quotationId: response.body.quotationId,
        organizationId: buyer,
        supplierOrganizationId: invitees[0],
        revision: 1,
        receivedAt: response.body.receivedAt,
        contentCommitment: response.body.contentCommitment,
        ciphertextSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        previousReceipt: QUOTATION_SEALING.genesisReceipt(rfq.id),
        receipt: response.body.receipt,
        submittedBy: expect.any(String),
      });
    });

    it('revises at the revision read, chains each revision after the last link of the RFQ, and refuses a stale one, a withdrawn one and one past the limit', async () => {
      const { buyer, rfq, invitees } = await issued();
      const a = supplierAs(invitees[0]!);
      const b = supplierAs(invitees[1]!);
      const first = (await a.put(rfq.id, { content: content() })).body;
      const other = (await b.put(rfq.id, { content: content('990000') })).body;

      expect((await a.put(rfq.id, { expectedRevision: 2, content: content() })).status).toBe(409);
      const second = await a.put(rfq.id, { expectedRevision: 1, content: content('1200000') });
      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({ quotationId: first.quotationId, revision: 2 });
      expect(second.body.contentCommitment).not.toBe(first.contentCommitment);

      const chain = await links(rfq.id);
      expect(chain.map((link) => [link.seq, link.revision])).toEqual([
        [1, 1],
        [2, 1],
        [3, 2],
      ]);
      expect(chain[1]!.previous_receipt).toBe(first.receipt);
      expect(chain[2]!.previous_receipt).toBe(other.receipt);
      const [revised] = await h.events(buyer, 'QUOTATION_REVISED');
      expect(quotationRevisedPayloadSchema.parse(revised)).toMatchObject({
        revision: 2,
        previousReceipt: other.receipt,
        receipt: second.body.receipt,
      });

      // PROCUREMENT_QUOTATION_MAX_REVISIONS = 3 in this suite.
      expect((await a.put(rfq.id, { expectedRevision: 2, content: content() })).status).toBe(200);
      const fourth = await a.put(rfq.id, { expectedRevision: 3, content: content() });
      expect([fourth.status, codeOf(fourth)]).toEqual([422, 'QUOTATION_REVISION_LIMIT']);

      const withdrawn = await a.withdraw(rfq.id, 3);
      expect(withdrawn.status).toBe(200);
      expect(withdrawn.body).toMatchObject({ status: 'WITHDRAWN', revision: 3 });
      expect(withdrawn.body.withdrawnAt).toEqual(expect.any(String));
      const [gone] = await h.events(buyer, 'QUOTATION_WITHDRAWN');
      expect(quotationWithdrawnPayloadSchema.parse(gone)).toMatchObject({
        quotationId: first.quotationId,
        revision: 3,
      });
      // Final: neither revised, withdrawn again, nor replaced by a second quotation.
      const after = await a.put(rfq.id, { expectedRevision: 3, content: content() });
      expect([after.status, codeOf(after)]).toEqual([422, 'QUOTATION_NOT_SUBMITTED']);
      expect((await a.withdraw(rfq.id, 3)).status).toBe(422);
      expect((await a.put(rfq.id, { content: content() })).status).toBe(409);
      // The withdrawal extended no chain.
      expect(await links(rfq.id)).toHaveLength(4);
    });

    it('lets one of two simultaneous first quotations of one organization through; the other is 409', async () => {
      const { rfq, invitees } = await issued();
      const a = supplierAs(invitees[0]!);
      const outcomes = await Promise.all([
        a.put(rfq.id, { content: content() }),
        a.put(rfq.id, { content: content('7') }),
      ]);
      expect(outcomes.map((response) => response.status).sort()).toEqual([200, 409]);
      expect(await rows(rfq.id)).toHaveLength(1);
      expect(await links(rfq.id)).toHaveLength(1);
    });

    it('replays a repeated request with its key, recognised by a keyed digest — never a plain hash of the price', async () => {
      const { buyer, rfq, invitees } = await issued();
      const user = 'USR-QUOTER-1';
      const a = supplierAs(invitees[0]!, ['SUPPLIER'], user);
      const k = key();
      const first = await a.put(rfq.id, { content: content('4410000') }, k);
      const again = await a.put(rfq.id, { content: content('4410000') }, k);
      expect([first.status, again.status]).toEqual([200, 200]);
      expect(again.body).toEqual(first.body);
      expect(await h.events(buyer, 'QUOTATION_SUBMITTED')).toHaveLength(1);

      // Another price under the same key, or another person of the organization: no answer.
      expect((await a.put(rfq.id, { content: content('4410001') }, k)).status).toBe(409);
      const colleague = supplierAs(invitees[0]!, ['SUPPLIER'], 'USR-QUOTER-2');
      expect((await colleague.put(rfq.id, { content: content('4410000') }, k)).status).toBe(409);

      const [stored] = await h.api.prisma.client.$queryRaw<{ request_hash: string }[]>`
        SELECT request_hash FROM idempotency_key WHERE organization_id = ${invitees[0]!} AND key = ${k}`;
      expect(stored!.request_hash).toMatch(/^hmac-v1:run:[0-9a-f]{64}:[0-9a-f]{64}$/);
    });
  });

  describe('the deadline: half-open, on the database clock, after the lock', () => {
    it('takes a quotation one millisecond before quotationClosingAt and refuses it at that instant and after', async () => {
      const { rfq, deadline, invitees } = await issued();
      const a = supplierAs(invitees[0]!);
      h.clock.set(deadline);
      const at = await a.put(rfq.id, { content: content() });
      expect([at.status, codeOf(at)]).toEqual([422, 'QUOTATION_WINDOW_CLOSED']);
      h.clock.set(new Date(deadline.getTime() + 1));
      expect(codeOf(await a.put(rfq.id, { content: content() }))).toBe('QUOTATION_WINDOW_CLOSED');
      expect(await rows(rfq.id)).toEqual([]);

      h.clock.set(new Date(deadline.getTime() - 1));
      const before = await a.put(rfq.id, { content: content() });
      expect(before.status).toBe(200);
      expect(before.body.receivedAt).toBe(new Date(deadline.getTime() - 1).toISOString());

      // Revising and withdrawing are judged the same way.
      h.clock.set(deadline);
      expect(codeOf(await a.put(rfq.id, { expectedRevision: 1, content: content() }))).toBe(
        'QUOTATION_WINDOW_CLOSED',
      );
      expect(codeOf(await a.withdraw(rfq.id, 1))).toBe('QUOTATION_WINDOW_CLOSED');
      expect(await rows(rfq.id)).toMatchObject([{ status: 'SUBMITTED', revision: 1 }]);
    });

    it('judges a quotation that waited for the RFQ’s lock on the clock read after the wait, not before it', async () => {
      const { rfq, deadline, invitees } = await issued();
      h.clock.set(new Date(deadline.getTime() - 1));
      const hold = barrier();
      const holder = h.api.prisma.client.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM rfq WHERE id = ${rfq.id} FOR UPDATE`;
          hold.arrive();
          await hold.wait;
        },
        { timeout: 60_000 },
      );
      await hold.reached;

      try {
        const pending = started(supplierAs(invitees[0]!).put(rfq.id, { content: content() }));
        await waitForLockWaiter(h.api, /FOR SHARE OF r/);
        // The deadline passes while it waits.
        h.clock.set(deadline);
        hold.release();
        await holder;
        const response = await pending;
        expect([response.status, codeOf(response)]).toEqual([422, 'QUOTATION_WINDOW_CLOSED']);
      } finally {
        hold.release();
      }

      expect(await rows(rfq.id)).toEqual([]);
      expect(await links(rfq.id)).toEqual([]);
    });

    it('is kept by the database on its own clock: a write it refuses after the service said yes is 422, and nothing is written', async () => {
      // A deadline the real clock passed an hour ago, while the service is told it is a millisecond before.
      const now = await dbNow();
      const { buyer, rfq, deadline, invitees } = await issued({
        t0: new Date(now.getTime() - 3 * 24 * HOUR),
        deadline: new Date(now.getTime() - HOUR),
      });
      h.clock.set(new Date(deadline.getTime() - 1));
      const response = await supplierAs(invitees[0]!).put(rfq.id, { content: content() });
      expect([response.status, codeOf(response)]).toEqual([422, 'QUOTATION_WINDOW_CLOSED']);
      expect(await rows(rfq.id)).toEqual([]);
      expect(await links(rfq.id)).toEqual([]);
      expect(await h.events(buyer, 'QUOTATION_SUBMITTED')).toEqual([]);
    });
  });

  describe('a withdrawal and the close, each order', () => {
    it('a withdrawal in flight before the deadline holds the close until it commits; the close then counts it out', async () => {
      const { buyer, rfq, deadline, invitees } = await issuedForReal(8);
      const a = supplierAs(invitees[0]!);
      expect((await a.put(rfq.id, { content: content() })).status).toBe(200);
      expect((await supplierAs(invitees[1]!).put(rfq.id, { content: content() })).status).toBe(200);

      const publisher = h.api.get(EventPublisher);
      const enqueue = publisher.enqueue.bind(publisher);
      const paused = barrier();
      jest.spyOn(publisher, 'enqueue').mockImplementation(async (tx, event) => {
        if (event.eventName === 'QUOTATION_WITHDRAWN') {
          paused.arrive();
          await paused.wait;
        }
        return enqueue(tx, event);
      });
      try {
        // Written before the deadline, still uncommitted when it passes — inside the transaction's
        // budget (Prisma's 5 s), so the withdrawal starts 2.5 s before the deadline.
        await untilDatabaseClockReaches(new Date(deadline.getTime() - 2_500));
        const withdrawal = started(a.withdraw(rfq.id, 1));
        await paused.reached;
        await untilDatabaseClockReaches(deadline);
        const close = started(h.admin(buyer).closeRfq(rfq.id));
        await waitForLockWaiter(h.api, /FOR UPDATE/);
        paused.release();

        const [w, c] = await Promise.all([withdrawal, close]);
        expect([w.status, c.status]).toEqual([200, 200]);
      } finally {
        paused.release();
      }
      const [closed] = await h.events(buyer, 'RFQ_CLOSED');
      expect(rfqClosedPayloadSchema.parse(closed).quotationCount).toBe(1);
    });

    it('a close holding the RFQ makes a withdrawal queued behind it be judged after it: refused, and counted in', async () => {
      const { buyer, rfq, deadline, invitees } = await issuedForReal(6);
      const a = supplierAs(invitees[0]!);
      const submitted = (await a.put(rfq.id, { content: content() })).body;
      await untilDatabaseClockReaches(deadline);

      const publisher = h.api.get(EventPublisher);
      const enqueue = publisher.enqueue.bind(publisher);
      const paused = barrier();
      jest.spyOn(publisher, 'enqueue').mockImplementation(async (tx, event) => {
        if (event.eventName === 'RFQ_CLOSED') {
          paused.arrive();
          await paused.wait;
        }
        return enqueue(tx, event);
      });
      try {
        const close = started(h.admin(buyer).closeRfq(rfq.id));
        await paused.reached;
        const withdrawal = started(a.withdraw(rfq.id, 1));
        await waitForLockWaiter(h.api, /FOR SHARE OF r/);
        paused.release();

        const [c, w] = await Promise.all([close, withdrawal]);
        expect(c.status).toBe(200);
        expect([w.status, codeOf(w)]).toEqual([422, 'QUOTATION_WINDOW_CLOSED']);
      } finally {
        paused.release();
      }
      const [closed] = await h.events(buyer, 'RFQ_CLOSED');
      expect(rfqClosedPayloadSchema.parse(closed).quotationCount).toBe(1);
      expect(await rows(rfq.id)).toMatchObject([
        { id: submitted.quotationId, status: 'SUBMITTED' },
      ]);

      // Whatever writes it: the database refuses a withdrawal after the close on its own clock.
      await expect(
        h.api.prisma.client.$executeRaw`
          UPDATE quotation SET status = 'WITHDRAWN', withdrawn_at = received_at
           WHERE id = ${submitted.quotationId as string}`,
      ).rejects.toThrow(/ck_quotation_window/);
    });
  });

  describe('the amount, before anything is sealed (ADR-070 § 4)', () => {
    it('takes unitPriceMinor × totalQuantity up to 2^63 − 1 and refuses one rial more per unit — supplier-service not asked, nothing written', async () => {
      const { buyer, rfq, invitees } = await issued();
      const quantity = BigInt(rfq.totalQuantity);
      const largest = 9_223_372_036_854_775_807n / quantity;
      const a = supplierAs(invitees[0]!);

      const asked = h.supplier.asked.length;
      const over = await a.put(rfq.id, { content: content((largest + 1n).toString()) });
      expect([over.status, codeOf(over)]).toEqual([422, 'QUOTATION_AMOUNT_OUT_OF_RANGE']);
      expect(h.supplier.asked.length).toBe(asked);
      expect(await rows(rfq.id)).toEqual([]);
      expect(await h.events(buyer, 'QUOTATION_SUBMITTED')).toEqual([]);

      expect((await a.put(rfq.id, { content: content(largest.toString()) })).status).toBe(200);
      // A revision is held to the same bound.
      const revised = await a.put(rfq.id, {
        expectedRevision: 1,
        content: content((largest + 1n).toString()),
      });
      expect(codeOf(revised)).toBe('QUOTATION_AMOUNT_OUT_OF_RANGE');
      expect(await rows(rfq.id)).toMatchObject([{ revision: 1 }]);
    });

    it('wants one answer per criterion of the RFQ', async () => {
      const { rfq, invitees } = await issued();
      const a = supplierAs(invitees[0]!);
      const unknown = await a.put(rfq.id, {
        content: content('10', {
          answers: [...content().answers, { criterionCode: 'X', answer: 'y' }],
        }),
      });
      expect(codeOf(unknown)).toBe('UNKNOWN_CRITERION');
      const missing = await a.put(rfq.id, {
        content: content('10', { answers: [{ criterionCode: 'PRICE', answer: 'y' }] }),
      });
      expect(codeOf(missing)).toBe('CRITERION_UNANSWERED');
      expect(await rows(rfq.id)).toEqual([]);
    });
  });

  describe('the body budget, through the parser production runs (PR-605 r1 F1)', () => {
    const FIFTY_CRITERIA = CRITERION_CODES.map((code) => ({
      code,
      label: code,
      weightBp: 200,
      scoringMethod: 'MANUAL_SCORE',
      maxScore: 100,
    }));
    const wireBytes = (body: object | string) =>
      Buffer.byteLength(typeof body === 'string' ? body : JSON.stringify(body));
    /** The refusal of the schema, never the transport's. */
    const expectOverBudget = (response: request.Response) => {
      expect([response.status, response.body.code, codeOf(response)]).toEqual([
        400,
        'VALIDATION_FAILED',
        'too_big',
      ]);
      expect(response.body.details[0].message).toContain(
        `at most ${QUOTATION_BODY_MAX_BYTES} bytes`,
      );
    };

    it.each([
      ['ASCII', 'x', false],
      ['Persian', 'ب', false],
      ['escape-heavy', '"\\\n\t\u0001', false],
      ['answers and a note', 'ب', true],
    ])('%s: submit and revise at the budget, refused one byte over', async (_, unit, note) => {
      const { buyer, rfq, invitees } = await issued({ criteria: FIFTY_CRITERIA });
      const a = supplierAs(invitees[0]!);
      const asked = h.supplier.asked.length;

      const tooBig = quotationBodyOfBytes(QUOTATION_BODY_MAX_BYTES + 1, unit, { note });
      expect(wireBytes(tooBig)).toBe(QUOTATION_BODY_MAX_BYTES + 1);
      expectOverBudget(await a.put(rfq.id, tooBig));
      expect(h.supplier.asked.length).toBe(asked);
      expect(await rows(rfq.id)).toEqual([]);

      const first = quotationBodyOfBytes(QUOTATION_BODY_MAX_BYTES, unit, { note });
      expect(wireBytes(first)).toBe(QUOTATION_BODY_MAX_BYTES);
      const submitted = await a.put(rfq.id, first);
      expect([submitted.status, submitted.body.revision]).toEqual([200, 1]);

      const options = { note, expectedRevision: 1 };
      const tooBigRevision = quotationBodyOfBytes(QUOTATION_BODY_MAX_BYTES + 1, unit, options);
      expect(wireBytes(tooBigRevision)).toBe(QUOTATION_BODY_MAX_BYTES + 1);
      expectOverBudget(await a.put(rfq.id, tooBigRevision));
      expect(await rows(rfq.id)).toMatchObject([{ revision: 1 }]);

      const revision = quotationBodyOfBytes(QUOTATION_BODY_MAX_BYTES, unit, options);
      expect(wireBytes(revision)).toBe(QUOTATION_BODY_MAX_BYTES);
      const revised = await a.put(rfq.id, revision);
      expect([revised.status, revised.body.revision]).toEqual([200, 2]);

      expect(await h.events(buyer, 'QUOTATION_SUBMITTED')).toHaveLength(1);
      expect(await h.events(buyer, 'QUOTATION_REVISED')).toHaveLength(1);
    });

    it('takes the bodies the review found refused: 33 × 2,000 ASCII and 17 × 2,000 Persian characters', async () => {
      const { rfq, invitees } = await issued({ criteria: FIFTY_CRITERIA });
      const answers = (count: number, character: string) => ({
        content: {
          unitPriceMinor: '10',
          answers: CRITERION_CODES.map((criterionCode, index) => ({
            criterionCode,
            answer: index < count ? character.repeat(2000) : character,
          })),
        },
      });
      for (const [invitee, body] of [
        [invitees[0]!, answers(33, 'x')],
        [invitees[1]!, answers(17, 'ب')],
      ] as const) {
        expect(wireBytes(body)).toBeGreaterThan(64 * 1024);
        expect((await supplierAs(invitee).put(rfq.id, body)).status).toBe(200);
      }
    });

    it('takes an at-budget body in the spellings a client may use: \\uXXXX, CRLF', async () => {
      const { rfq, invitees } = await issued({ criteria: FIFTY_CRITERIA });
      const persian = JSON.stringify(quotationBodyOfBytes(QUOTATION_BODY_MAX_BYTES, 'ب')).replace(
        /[\u0080-\uffff]/g,
        (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`,
      );
      const crlf = JSON.stringify(quotationBodyOfBytes(QUOTATION_BODY_MAX_BYTES, '\n')).replace(
        /\\n/g,
        '\\r\\n',
      );
      for (const [invitee, wire] of [
        [invitees[0]!, persian],
        [invitees[1]!, crlf],
      ] as const) {
        expect(wireBytes(wire)).toBeGreaterThan(QUOTATION_BODY_MAX_BYTES);
        expect(wireBytes(wire)).toBeLessThanOrEqual(JSON_BODY_LIMIT_BYTES);
        expect((await supplierAs(invitee).put(rfq.id, wire)).status).toBe(200);
      }
    });

    it.each([
      ['Persian', 'ب'],
      ['text JSON escapes to 2 bytes', '"'],
    ])(
      'judges the largest body within the field bounds, of %s: never 413',
      async (_, character) => {
        const { rfq, invitees } = await issued();
        const body = largestQuotationBody(character);
        expect(wireBytes(body)).toBeGreaterThan(2 * QUOTATION_BODY_MAX_BYTES);
        expect(wireBytes(body)).toBeLessThanOrEqual(JSON_BODY_LIMIT_BYTES);
        expectOverBudget(await supplierAs(invitees[0]!).put(rfq.id, body));
      },
    );

    it('does not read what is above the limit as sent, within the field bounds or not: the documented 413', async () => {
      const { rfq, invitees } = await issued();
      const body = largestQuotationBody('😀');
      expect(wireBytes(body)).toBeGreaterThan(JSON_BODY_LIMIT_BYTES);
      const refused = await supplierAs(invitees[0]!).put(rfq.id, body);
      expect([refused.status, refused.body.code]).toEqual([413, 'PAYLOAD_TOO_LARGE']);
    });

    it('reads a body to the parser limit and refuses one byte more with 413', async () => {
      const { rfq, invitees } = await issued();
      const a = supplierAs(invitees[0]!);
      const body = JSON.stringify({ content: {} });
      const padded = (bytes: number) => body + ' '.repeat(bytes - wireBytes(body));

      const read = await a.put(rfq.id, padded(JSON_BODY_LIMIT_BYTES));
      expect([read.status, read.body.code]).toEqual([400, 'VALIDATION_FAILED']);
      const refused = await a.put(rfq.id, padded(JSON_BODY_LIMIT_BYTES + 1));
      expect([refused.status, refused.body.code]).toEqual([413, 'PAYLOAD_TOO_LARGE']);
    });
  });

  describe('the standing, from supplier-service, fail closed', () => {
    it('refuses a supplier suspended since the invitation, and writes nothing when supplier-service cannot say', async () => {
      const { rfq, invitees } = await issued();
      h.supplier.set(invitees[0]!, 'SUSPENDED');
      const suspended = await supplierAs(invitees[0]!).put(rfq.id, { content: content() });
      expect([suspended.status, codeOf(suspended)]).toEqual([422, 'SUPPLIER_NOT_ELIGIBLE']);
      h.supplier.set(invitees[1]!, 'DOWN');
      expect((await supplierAs(invitees[1]!).put(rfq.id, { content: content() })).status).toBe(503);
      expect(await rows(rfq.id)).toEqual([]);

      // Withdrawing asks nothing: a supplier suspended since may take its quotation back.
      h.supplier.set(invitees[1]!, 'ELIGIBLE');
      const b = supplierAs(invitees[1]!);
      expect((await b.put(rfq.id, { content: content() })).status).toBe(200);
      h.supplier.set(invitees[1]!, 'DOWN');
      expect((await b.withdraw(rfq.id, 1)).status).toBe(200);
    });
  });

  describe('who reaches an RFQ through this door', () => {
    it('is the invited supplier only: an RFQ that does not invite the caller, a third organization’s and an unknown one are the same 404, with nothing asked or written', async () => {
      const outsider = h.supplier.organization();
      suppliers.push(outsider);
      const { buyer, rfq, invitees } = await issued();
      const asked = h.supplier.asked.length;
      const refusals = await Promise.all([
        supplierAs(outsider).put(rfq.id, { content: content() }),
        supplierAs(outsider).withdraw(rfq.id, 1),
        supplierAs(buyer, ['SUPPLIER', 'ORGANIZATION_ADMIN']).put(rfq.id, { content: content() }),
        supplierAs(invitees[0]!).put('RFQ_01JZZZZZZZZZZZZZZZZZZZZZZZ', { content: content() }),
      ]);
      expect(refusals.map((response) => response.status)).toEqual([404, 404, 404, 404]);
      expect(h.supplier.asked.length).toBe(asked);
      expect(await rows(rfq.id)).toEqual([]);
      expect(await h.events(buyer, 'QUOTATION_SUBMITTED')).toEqual([]);
    });

    it('takes the RFQ’s share lock only through the caller’s own invitation — the second layer, under the read before it', async () => {
      const outsider = h.supplier.organization();
      suppliers.push(outsider);
      const { buyer, rfq, invitees } = await issued();
      const repository = h.api.get(QuotationRepository);
      const lock = (organizationId: string) =>
        h.api.prisma.client.$transaction((tx) =>
          repository.lockInvitedRfq(tx as never, organizationId, rfq.id),
        );
      expect(await lock(outsider)).toBeNull();
      expect(await lock(buyer)).toBeNull();
      expect(await lock(invitees[0]!)).toMatchObject({ id: rfq.id, organizationId: buyer });
    });

    it('acts on the caller’s own quotation only: another invitee’s is out of reach', async () => {
      const { rfq, invitees } = await issued();
      expect((await supplierAs(invitees[0]!).put(rfq.id, { content: content() })).status).toBe(200);
      const theirs = await supplierAs(invitees[1]!).withdraw(rfq.id, 1);
      expect(theirs.status).toBe(404);
      const revise = await supplierAs(invitees[1]!).put(rfq.id, {
        expectedRevision: 1,
        content: content(),
      });
      expect(revise.status).toBe(404);
      expect(await rows(rfq.id)).toMatchObject([
        { supplier_organization_id: invitees[0], status: 'SUBMITTED' },
      ]);
    });

    it('refuses, before anything is read, a role the configuration does not grant, AUDITOR, the platform administrator beside SUPPLIER, and a service', async () => {
      const { rfq, invitees } = await issued();
      const invited = invitees[0]!;
      const asked = h.supplier.asked.length;
      const service = await internalToken('construction-service', invited);
      const refusals = await Promise.all([
        supplierAs(invited, ['PROCUREMENT_USER']).put(rfq.id, { content: content() }),
        supplierAs(invited, ['AUDITOR', 'SUPPLIER']).put(rfq.id, { content: content() }),
        supplierAs(invited, ['SYSTEM_ADMIN', 'SUPPLIER']).put(rfq.id, { content: content() }),
        request(h.api.app.getHttpServer())
          .put(`/v1/rfqs/${rfq.id}/quotations/mine`)
          .set('x-internal-token', service)
          .set('idempotency-key', key())
          .send({ content: content() }),
      ]);
      expect(refusals.map((response) => response.status)).toEqual([403, 403, 403, 403]);
      expect(h.supplier.asked.length).toBe(asked);
      expect(await rows(rfq.id)).toEqual([]);
    });
  });

  it('puts nothing sealed — price, answer, note — on an event, in a log, in the idempotency store or in the stored row', async () => {
    const MARKER = 'zz-sealed-marker-نشانه';
    const PRICE = '7364019285';
    // A price no generated value (a ULID, a digest) can hold a piece of (#452).
    const price = new RegExp(`(?<![0-9A-Za-z])${PRICE}(?![0-9A-Za-z])`);
    const { buyer, rfq, invitees } = await issued();
    const supplier = invitees[0]!;
    const a = supplierAs(supplier);

    const logged: string[] = [];
    const logger = h.api.app.get<object>(LOGGER);
    const stream = Object.getOwnPropertySymbols(logger)
      .filter((symbol) => symbol.description === 'pino.stream')
      .map((symbol) => (logger as Record<symbol, { write(chunk: unknown): boolean }>)[symbol])[0];
    if (!stream) throw new Error('the service logger has no stream to watch');
    // Every sink a line can leave by: the service logger's stream, Nest's console logger, console.
    const sinks: [Record<string, unknown>, string][] = [
      [stream as unknown as Record<string, unknown>, 'write'],
      [process.stdout as unknown as Record<string, unknown>, 'write'],
      [process.stderr as unknown as Record<string, unknown>, 'write'],
      ...(['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const).map(
        (method) =>
          [logger as Record<string, unknown>, method] as [Record<string, unknown>, string],
      ),
      ...(['log', 'info', 'warn', 'error', 'debug'] as const).map(
        (method) =>
          [console as unknown as Record<string, unknown>, method] as [
            Record<string, unknown>,
            string,
          ],
      ),
    ];
    const originals = sinks.map(([target, method]) => target[method]);
    for (const [target, method] of sinks) {
      target[method] = (...args: unknown[]) => {
        logged.push(
          args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '),
        );
        return true;
      };
    }
    const restore = () =>
      sinks.forEach(([target, method], index) => {
        target[method] = originals[index];
      });

    const sealed = content(PRICE, {
      answers: [
        { criterionCode: 'PRICE', answer: `${MARKER} delivered` },
        { criterionCode: 'ISO', answer: MARKER },
      ],
      note: `${MARKER} note`,
    });
    let responses: request.Response[];
    try {
      responses = [
        await a.put(rfq.id, { content: sealed }),
        await a.put(rfq.id, { expectedRevision: 1, content: sealed }),
        // Refused after the content was read: the refusal path logs too.
        await a.put(rfq.id, { expectedRevision: 9, content: sealed }),
        await a.put(rfq.id, {
          content: {
            ...sealed,
            answers: [...sealed.answers, { criterionCode: 'NOPE', answer: MARKER }],
          },
        }),
        await a.withdraw(rfq.id, 2),
      ];
    } finally {
      restore();
    }
    expect(responses.map((response) => response.status)).toEqual([200, 200, 409, 422, 200]);

    const outbox = await h.api.prisma.client.outboxMessage.findMany({
      where: { organizationId: { in: [buyer, supplier] } },
    });
    expect(
      outbox
        .map((row) => row.eventName)
        .filter((name) => name.startsWith('QUOTATION_'))
        .sort(),
    ).toEqual(['QUOTATION_REVISED', 'QUOTATION_SUBMITTED', 'QUOTATION_WITHDRAWN']);
    const idempotency = await h.api.prisma.client.$queryRaw<unknown[]>`
      SELECT request_hash, response_body FROM idempotency_key WHERE organization_id = ${supplier}`;
    const stored = await h.api.prisma.client.$queryRaw<{ ciphertext: Buffer }[]>`
      SELECT ciphertext FROM quotation WHERE rfq_id = ${rfq.id}`;

    expectNotDisclosed(
      {
        outbox: outbox.map((row) => row.payload),
        idempotency,
        responses: responses.map((response) => response.body),
        logged,
      },
      [MARKER, price],
    );
    expect(logged.length).toBeGreaterThan(0);
    for (const row of stored) {
      expect(row.ciphertext.includes(Buffer.from(MARKER, 'utf8'))).toBe(false);
      expect(row.ciphertext.includes(Buffer.from(PRICE, 'utf8'))).toBe(false);
    }
  });
});
