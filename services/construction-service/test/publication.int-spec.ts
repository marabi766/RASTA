import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runUnscoped } from '@rasta/nest-common';
import { eventEnvelopeSchema } from '@rasta/contracts';
import type { CriterionInput } from '../src/tender/criteria.dto';
import {
  genesisReceipt,
  nextReceipt,
  openBid,
  privateKeyFromDer,
  sealBid,
} from '../src/tender/sealing/sealing';
import {
  activatePublicationPolicy,
  approvedProject,
  asAdmin,
  cleanup,
  newOrganizationId,
  outboxFor,
  testEnv,
  untilASessionWaitsOnALock,
  wire,
  type Wiring,
} from './helpers';

/**
 * Publishing a tender and inviting bidders against PostgreSQL (ADR-065, ADR-066
 * § 2): the guards, the database's clock, the key pair that is made and only ever
 * stored wrapped, the freeze that follows, and the races.
 */

const WHOLE: CriterionInput[] = [
  { code: 'PRICE', label: 'Price', weightBp: 6000, scoringMethod: 'MANUAL_SCORE', maxScore: 100 },
  { code: 'LICENCE', label: 'Licence', weightBp: 4000, scoringMethod: 'PASS_FAIL', maxScore: 1 },
];

const DAY = 24 * 60 * 60 * 1000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

const payloadOf = (row: { payload: unknown }) => eventEnvelopeSchema.parse(row.payload).payload;

describe('publishing a tender', () => {
  let w: Wiring;
  const organizations: string[] = [];
  const extraWirings: Wiring[] = [];

  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };

  interface Ready {
    visibility?: 'PUBLIC' | 'RESTRICTED' | null;
    nature?: 'FORMAL_TENDER' | null;
    window?: { opening: string; closing: string } | null;
    criteria?: CriterionInput[];
  }

  /** A DRAFT tender of a fresh organization, made ready (or not) as `ready` says. */
  async function draft(ready: Ready = {}, wiring: Wiring = w) {
    const a = org();
    const project = await approvedProject(wiring, a);
    const window =
      ready.window === undefined ? { opening: iso(DAY), closing: iso(30 * DAY) } : ready.window;
    const tender = await asAdmin(a, () =>
      wiring.tenders.create(project.id, {
        title: 'Road resurfacing',
        scopeOfWork: 'Two kilometres of the main road',
        ...(ready.nature === null ? {} : { procurementNature: ready.nature ?? 'FORMAL_TENDER' }),
        ...(ready.visibility === null ? {} : { visibility: ready.visibility ?? 'PUBLIC' }),
        ...(window ? { bidOpeningAt: window.opening, bidClosingAt: window.closing } : {}),
      }),
    );
    let version = tender.version;
    const criteria = ready.criteria ?? WHOLE;
    if (criteria.length > 0) {
      const set = await asAdmin(a, () =>
        wiring.criteria.setCriteria(tender.id, { expectedVersion: version, criteria }),
      );
      version = set.version;
    }
    return { a, project, tender, version };
  }

  const keyRow = (a: string, tenderId: string) =>
    // `async`/`await`: a Prisma call is lazy and would otherwise run after the context has gone.
    asAdmin(a, async () => await w.prisma.client.tenderKey.findFirst({ where: { tenderId } }));

  const refusalsOf = async (call: Promise<unknown>): Promise<string> => {
    const error = (await call.then(
      () => undefined,
      (e: unknown) => e,
    )) as { code?: string; message?: string } | undefined;
    expect(error?.code).toBe('BUSINESS_RULE_VIOLATION');
    return error?.message ?? '';
  };

  beforeAll(() => {
    w = wire();
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    for (const extra of extraWirings) await extra.close();
    await w.close();
  });

  describe('a complete draft', () => {
    it('is published: state, who and when, the event, and the criteria frozen', async () => {
      const { a, project, tender, version } = await draft();

      const published = await asAdmin(a, () =>
        w.publication.publishApproved(tender.id, { expectedVersion: version }),
      );

      expect(published).toMatchObject({
        status: 'PUBLISHED',
        version: version + 1,
        publishedBy: expect.any(String),
        publishedAt: expect.any(String),
        visibility: 'PUBLIC',
      });
      const event = (await outboxFor(w.prisma, a)).find(
        (row) => row.eventName === 'TENDER_PUBLISHED',
      )!;
      expect(event).toMatchObject({ aggregateType: 'Tender', partitionKey: tender.id });
      const stored = await keyRow(a, tender.id);
      expect(payloadOf(event)).toEqual({
        tenderId: tender.id,
        projectId: project.id,
        organizationId: a,
        visibility: 'PUBLIC',
        bidOpeningAt: tender.bidOpeningAt,
        bidClosingAt: tender.bidClosingAt,
        criteriaCount: 2,
        keyId: stored!.keyId,
        publishedBy: published.publishedBy,
        publishedAt: published.publishedAt,
      });
      const wire = JSON.stringify(event.payload);
      expect(wire).not.toContain('Road resurfacing');
      expect(wire).not.toContain('PUBLIC KEY');
      expect(wire).not.toContain('PRICE');

      // No longer editable, and the criteria are frozen.
      await expect(
        asAdmin(a, () =>
          w.tenders.update(tender.id, { expectedVersion: version + 1, title: 'Late' }),
        ),
      ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
      await expect(
        asAdmin(a, () =>
          w.criteria.setCriteria(tender.id, { expectedVersion: version + 1, criteria: WHOLE }),
        ),
      ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
      await expect(
        w.prisma.client.$executeRawUnsafe(
          `UPDATE "tender_criterion" SET "weight_bp" = 1 WHERE "tender_id" = '${tender.id}'`,
        ),
      ).rejects.toThrow(/ck_tender_criteria_frozen/);
    });

    it('makes a key pair whose private half is stored wrapped, and opens a bid end to end', async () => {
      const { a, tender, version } = await draft();
      await asAdmin(a, () =>
        w.publication.publishApproved(tender.id, { expectedVersion: version }),
      );

      const stored = (await keyRow(a, tender.id))!;
      expect(stored.publicKeyPem).toContain('BEGIN PUBLIC KEY');
      expect(stored.kekId).toBe('itest-1');
      // Nothing of the private key is stored in the clear.
      expect(Buffer.from(stored.wrappedPrivateKey).includes(Buffer.from('PRIVATE KEY'))).toBe(
        false,
      );
      expect(stored.publicKeyPem).not.toContain('PRIVATE');

      // A bid sealed to the stored public key opens with the unwrapped private key.
      const binding = {
        tenderId: tender.id,
        bidId: 'BID_1',
        bidderOrganizationId: 'ORG_BIDDER',
        revision: 1,
        keyId: stored.keyId,
      };
      const sealed = sealBid({
        publicKeyPem: stored.publicKeyPem,
        binding,
        content: { priceMinor: '4200000000' },
      });
      const link = {
        bidId: 'BID_1',
        revision: 1,
        receivedAt: new Date('2026-11-01T08:00:00.000Z'),
        ciphertextSha256: sealed.ciphertextSha256,
        contentCommitment: sealed.contentCommitment,
      };
      const receipt = nextReceipt(tender.id, genesisReceipt(tender.id), link);
      const der = w.keys.unwrap(
        {
          kekId: stored.kekId,
          nonce: Buffer.from(stored.wrapNonce),
          ciphertext: Buffer.from(stored.wrappedPrivateKey),
          tag: Buffer.from(stored.wrapTag),
        },
        { tenderId: tender.id, keyId: stored.keyId },
      );
      expect(
        openBid({
          privateKey: privateKeyFromDer(der),
          binding,
          sealed,
          receipts: { links: [{ ...link, receipt }], head: receipt },
        }),
      ).toEqual({ priceMinor: '4200000000' });
      der.fill(0);
    });

    it('can still be cancelled once published, and its key is kept', async () => {
      const { a, tender, version } = await draft();
      const published = await asAdmin(a, () =>
        w.publication.publishApproved(tender.id, { expectedVersion: version }),
      );
      const cancelled = await asAdmin(a, () =>
        w.tenders.cancel(tender.id, {
          expectedVersion: published.version,
          reason: 'Funding was withdrawn',
        }),
      );
      expect(cancelled.status).toBe('CANCELLED');
      expect(await keyRow(a, tender.id)).not.toBeNull();
    });
  });

  describe('the approval gate fails closed (Q-84)', () => {
    const untouched = async (a: string, tenderId: string, version: number) => {
      const now = await asAdmin(a, () => w.tenders.get(tenderId));
      expect(now).toMatchObject({ status: 'DRAFT', version, publishedAt: null });
      expect(await keyRow(a, tenderId)).toBeNull();
      expect(
        (await outboxFor(w.prisma, a)).some((row) => row.eventName === 'TENDER_PUBLISHED'),
      ).toBe(false);
    };

    it('refuses with APPROVAL_POLICY_REQUIRED when the organization has no active policy', async () => {
      const { a, tender, version } = await draft();

      const message = await refusalsOf(
        asAdmin(a, () => w.publication.publish(tender.id, { expectedVersion: version })),
      );

      expect(message).toContain('APPROVAL_POLICY_REQUIRED');
      expect(message).not.toContain('APPROVAL_REQUIRED');
      await untouched(a, tender.id, version);
    });

    it('still refuses with APPROVAL_REQUIRED while the round is not wired, even with a policy in force', async () => {
      const { a, tender, version } = await draft();
      await activatePublicationPolicy(w, a);

      const message = await refusalsOf(
        asAdmin(a, () => w.publication.publish(tender.id, { expectedVersion: version })),
      );

      expect(message).toContain('APPROVAL_REQUIRED');
      expect(message).not.toContain('APPROVAL_POLICY_REQUIRED');
      await untouched(a, tender.id, version);
    });

    it('does not take another organization’s policy for its own', async () => {
      const mine = await draft();
      const other = await draft();
      await activatePublicationPolicy(w, other.a);

      const message = await refusalsOf(
        asAdmin(mine.a, () =>
          w.publication.publish(mine.tender.id, { expectedVersion: mine.version }),
        ),
      );

      expect(message).toContain('APPROVAL_POLICY_REQUIRED');
    });

    it('names the gate together with every other reason', async () => {
      const { a, tender, version } = await draft({ criteria: [], visibility: 'RESTRICTED' });

      const message = await refusalsOf(
        asAdmin(a, () => w.publication.publish(tender.id, { expectedVersion: version })),
      );

      for (const code of ['CRITERIA_REQUIRED', 'INVITATION_REQUIRED', 'APPROVAL_POLICY_REQUIRED']) {
        expect(message).toContain(code);
      }
    });

    it('makes no key pair for a request that cannot succeed', async () => {
      const { a, tender, version } = await draft();
      const spy = jest.spyOn(w.keys, 'wrap');
      try {
        await asAdmin(a, () =>
          w.publication.publish(tender.id, { expectedVersion: version }),
        ).catch(() => undefined);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it('leaves the publication core to the approved path, which still publishes', async () => {
      const { a, tender, version } = await draft();
      const published = await asAdmin(a, () =>
        w.publication.publishApproved(tender.id, { expectedVersion: version }),
      );
      expect(published.status).toBe('PUBLISHED');
    });
  });

  describe('the publication is dated by the decision, after the lock', () => {
    it('stamps the row, the key and the event with an instant read after waiting for the tender', async () => {
      const { a, tender, version } = await draft();

      // Another transaction holds the tender row; the publication queues behind it.
      let release!: () => void;
      let holding!: () => void;
      const mayRelease = new Promise<void>((resolve) => (release = resolve));
      const held = new Promise<void>((resolve) => (holding = resolve));
      const holder = w.prisma.client.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(`SELECT "id" FROM "tender" WHERE "id" = $1 FOR UPDATE`, tender.id);
        holding();
        await mayRelease;
      });
      await held;

      const publishing = asAdmin(a, () =>
        w.publication.publishApproved(tender.id, { expectedVersion: version }),
      );
      await untilASessionWaitsOnALock(w.prisma);
      const [{ now: released }] = await w.prisma.client.$queryRawUnsafe<{ now: Date }[]>(
        'SELECT clock_timestamp() AS now',
      );
      release();
      await holder;
      const published = await publishing;

      // The transaction began before `released`; the decision came after it.
      expect(Date.parse(published.publishedAt!)).toBeGreaterThanOrEqual(released!.getTime());
      const stored = await keyRow(a, tender.id);
      expect(stored!.createdAt.toISOString()).toBe(published.publishedAt);
      const event = (await outboxFor(w.prisma, a)).find(
        (row) => row.eventName === 'TENDER_PUBLISHED',
      )!;
      expect(payloadOf(event)).toMatchObject({ publishedAt: published.publishedAt });
      expect(eventEnvelopeSchema.parse(event.payload).occurredAt).toBe(published.publishedAt);
    });
  });

  describe('a draft that is not ready', () => {
    const nothingChanged = async (a: string, tenderId: string, version: number) => {
      const now = await asAdmin(a, () => w.tenders.get(tenderId));
      expect(now).toMatchObject({ status: 'DRAFT', version, publishedAt: null, publishedBy: null });
      expect(await keyRow(a, tenderId)).toBeNull();
      expect((await outboxFor(w.prisma, a)).map((row) => row.eventName)).not.toContain(
        'TENDER_PUBLISHED',
      );
    };

    it.each<[string, Ready, string]>([
      ['no procurement nature', { nature: null }, 'NATURE_REQUIRED'],
      ['no visibility', { visibility: null }, 'VISIBILITY_REQUIRED'],
      ['no window', { window: null }, 'WINDOW_REQUIRED'],
      [
        'a window that has already closed (the database clock, not the caller’s)',
        {
          window: { opening: '2020-01-01T00:00:00Z', closing: '2020-02-01T00:00:00Z' },
        },
        'WINDOW_ALREADY_CLOSED',
      ],
      ['no criteria', { criteria: [] }, 'CRITERIA_REQUIRED'],
      [
        'weights that do not sum to 10000',
        { criteria: [{ ...WHOLE[0]!, weightBp: 5000 }] },
        'CRITERIA_WEIGHTS_INCOMPLETE',
      ],
      [
        'a restricted tender nobody is invited to',
        { visibility: 'RESTRICTED' },
        'INVITATION_REQUIRED',
      ],
    ])('is refused with %s, and nothing is written', async (_label, ready, code) => {
      const { a, tender, version } = await draft(ready);

      const message = await refusalsOf(
        asAdmin(a, () => w.publication.publishApproved(tender.id, { expectedVersion: version })),
      );

      expect(message).toContain(code);
      await nothingChanged(a, tender.id, version);
    });

    it('names every reason at once', async () => {
      const { a, tender, version } = await draft({
        nature: null,
        visibility: 'RESTRICTED',
        window: null,
        criteria: [{ ...WHOLE[0]!, weightBp: 5000 }],
      });
      const message = await refusalsOf(
        asAdmin(a, () => w.publication.publishApproved(tender.id, { expectedVersion: version })),
      );
      for (const code of [
        'NATURE_REQUIRED',
        'WINDOW_REQUIRED',
        'CRITERIA_WEIGHTS_INCOMPLETE',
        'INVITATION_REQUIRED',
      ]) {
        expect(message).toContain(code);
      }
      await nothingChanged(a, tender.id, version);
    });

    it('is refused when the window is shorter than the configured minimum, and only then', async () => {
      const strict = wire(testEnv({ CONSTRUCTION_TENDER_MIN_BIDDING_PERIOD_SECONDS: '31536000' }));
      extraWirings.push(strict);
      const { a, tender, version } = await draft({}, strict);

      const message = await refusalsOf(
        asAdmin(a, () => strict.publication.publish(tender.id, { expectedVersion: version })),
      );

      expect(message).toContain('WINDOW_TOO_SHORT');
      // The same tender is publishable where no minimum is configured.
      await expect(
        asAdmin(a, () => w.publication.publishApproved(tender.id, { expectedVersion: version })),
      ).resolves.toMatchObject({ status: 'PUBLISHED' });
    });

    it('is refused for a stale version before anything is made', async () => {
      const { a, tender, version } = await draft();
      await expect(
        asAdmin(a, () =>
          w.publication.publishApproved(tender.id, { expectedVersion: version - 1 }),
        ),
      ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });
      await nothingChanged(a, tender.id, version);
    });

    it('is refused a second time, and from a state that is not DRAFT', async () => {
      const { a, tender, version } = await draft();
      await asAdmin(a, () =>
        w.publication.publishApproved(tender.id, { expectedVersion: version }),
      );
      await expect(
        asAdmin(a, () =>
          w.publication.publishApproved(tender.id, { expectedVersion: version + 1 }),
        ),
      ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    });
  });

  describe('with no key-encryption key configured', () => {
    it('publishes nothing: a tender whose bids cannot be sealed does not open', async () => {
      const bare = wire(
        testEnv({ CONSTRUCTION_TENDER_KEKS: '', CONSTRUCTION_TENDER_KEK_CURRENT: '' }),
      );
      extraWirings.push(bare);
      const { a, tender, version } = await draft({}, bare);

      await expect(
        asAdmin(a, () => bare.publication.publishApproved(tender.id, { expectedVersion: version })),
      ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });

      expect(await asAdmin(a, () => w.tenders.get(tender.id))).toMatchObject({
        status: 'DRAFT',
        version,
      });
      expect(await keyRow(a, tender.id)).toBeNull();
    });
  });

  describe('the migration’s rollback', () => {
    it('refuses while a tender key exists, and touches nothing', async () => {
      // The rollback drops `tender_key`; re-applying the migration would leave
      // published tenders with no private key. So its preflight — the very text of
      // down.sql, run after its own LOCK — stops it while any key is stored.
      const sql = readFileSync(
        join(
          __dirname,
          '..',
          'prisma',
          'migrations',
          '20260930180000_tender_publication',
          'down.sql',
        ),
        'utf8',
      );
      const lock = /^LOCK TABLE [^;]+;/m.exec(sql)?.[0];
      const preflight = /DO \$preflight\$[\s\S]*?\$preflight\$;/.exec(sql)?.[0];
      expect(lock).toContain('ACCESS EXCLUSIVE');
      expect(preflight).toBeDefined();
      expect(sql.indexOf(lock!)).toBeLessThan(sql.indexOf(preflight!));
      expect(sql.indexOf(preflight!)).toBeLessThan(sql.indexOf('DROP TABLE'));

      const { a, tender, version } = await draft();
      await asAdmin(a, () =>
        w.publication.publishApproved(tender.id, { expectedVersion: version }),
      );
      expect(await keyRow(a, tender.id)).not.toBeNull();

      await expect(
        w.prisma.client.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(lock!.replace(/;$/, ''));
          await tx.$executeRawUnsafe(preflight!.replace(/;$/, ''));
        }),
      ).rejects.toThrow(/down refused: \d+ tender key\(s\) exist/);
      // The refusal rolled everything back: the key is still there.
      expect(await keyRow(a, tender.id)).not.toBeNull();
    });
  });

  describe('races', () => {
    it('lets exactly one of two concurrent publications win, with one key and one event', async () => {
      const { a, tender, version } = await draft();

      const results = await Promise.allSettled([
        asAdmin(a, () => w.publication.publishApproved(tender.id, { expectedVersion: version })),
        asAdmin(a, () => w.publication.publishApproved(tender.id, { expectedVersion: version })),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(
        (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason,
      ).toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });
      expect(
        (await outboxFor(w.prisma, a)).filter((row) => row.eventName === 'TENDER_PUBLISHED'),
      ).toHaveLength(1);
      expect(await keyRow(a, tender.id)).not.toBeNull();
    });

    it('serialises a publication with a cancellation: one applies, the other is refused', async () => {
      const { a, tender, version } = await draft();

      const [publish, cancel] = await Promise.allSettled([
        asAdmin(a, () => w.publication.publishApproved(tender.id, { expectedVersion: version })),
        asAdmin(a, () =>
          w.tenders.cancel(tender.id, {
            expectedVersion: version,
            reason: 'Funding was withdrawn',
          }),
        ),
      ]);

      expect([publish.status, cancel.status].filter((s) => s === 'fulfilled')).toHaveLength(1);
      const now = await asAdmin(a, () => w.tenders.get(tender.id));
      expect(now.status).toBe(publish.status === 'fulfilled' ? 'PUBLISHED' : 'CANCELLED');
      const key = await keyRow(a, tender.id);
      expect(key === null).toBe(publish.status !== 'fulfilled');
    });

    it('serialises a publication with a change of criteria: what was published is what is frozen', async () => {
      const { a, tender, version } = await draft();

      const [publish, set] = await Promise.allSettled([
        asAdmin(a, () => w.publication.publishApproved(tender.id, { expectedVersion: version })),
        asAdmin(a, () =>
          w.criteria.setCriteria(tender.id, {
            expectedVersion: version,
            criteria: [{ ...WHOLE[0]!, weightBp: 4000 }],
          }),
        ),
      ]);

      expect([publish.status, set.status].filter((s) => s === 'fulfilled')).toHaveLength(1);
      const criteria = await asAdmin(a, () => w.criteria.getCriteria(tender.id));
      if (publish.status === 'fulfilled') {
        expect(criteria.totalWeightBp).toBe(10_000);
      } else {
        expect(criteria.totalWeightBp).toBe(4000);
        expect((await asAdmin(a, () => w.tenders.get(tender.id))).status).toBe('DRAFT');
      }
    });

    it('answers with the state its own publication produced', async () => {
      const { a, tender, version } = await draft();
      const published = await asAdmin(a, () =>
        w.publication.publishApproved(tender.id, { expectedVersion: version }),
      );
      // Cancelled straight after: the earlier answer is still the publication's.
      await asAdmin(a, () =>
        w.tenders.cancel(tender.id, {
          expectedVersion: published.version,
          reason: 'Funding was withdrawn',
        }),
      );
      expect(published).toMatchObject({ status: 'PUBLISHED', version: version + 1 });
    });
  });

  describe('the tender key’s own guarantees', () => {
    it('is never deleted, its identity and public key never change, and its wrapping may be renewed', async () => {
      const { a, tender, version } = await draft();
      await asAdmin(a, () =>
        w.publication.publishApproved(tender.id, { expectedVersion: version }),
      );
      const run = (sql: string) => w.prisma.client.$executeRawUnsafe(sql);

      await expect(
        run(`DELETE FROM "tender_key" WHERE "tender_id" = '${tender.id}'`),
      ).rejects.toThrow(/ck_tender_key_immutable/);
      await expect(
        run(`UPDATE "tender_key" SET "key_id" = 'TKY_other' WHERE "tender_id" = '${tender.id}'`),
      ).rejects.toThrow(/ck_tender_key_immutable/);
      await expect(
        run(`UPDATE "tender_key" SET "public_key_pem" = 'x' WHERE "tender_id" = '${tender.id}'`),
      ).rejects.toThrow(/ck_tender_key_immutable/);
      await expect(
        run(`UPDATE "tender_key" SET "kek_id" = 'itest-2' WHERE "tender_id" = '${tender.id}'`),
      ).resolves.toBe(1);
    });

    it('refuses a wrapped key that is not what the AEAD produced, and a second key for one tender', async () => {
      const { a, tender, version } = await draft();
      await asAdmin(a, () =>
        w.publication.publishApproved(tender.id, { expectedVersion: version }),
      );
      const run = (sql: string) => w.prisma.client.$executeRawUnsafe(sql);

      await expect(
        run(
          `UPDATE "tender_key" SET "wrap_nonce" = '\\x00'::bytea WHERE "tender_id" = '${tender.id}'`,
        ),
      ).rejects.toThrow(/ck_tender_key_wrap_shape/);
      await expect(
        run(
          `INSERT INTO "tender_key" ("tender_id", "organization_id", "key_id", "public_key_pem", "kek_id",
             "wrap_nonce", "wrapped_private_key", "wrap_tag", "created_at", "created_by")
           VALUES ('${tender.id}', '${a}', 'TKY_second', 'pem', 'k', decode('${'00'.repeat(12)}', 'hex'),
             decode('00', 'hex'), decode('${'00'.repeat(16)}', 'hex'), now(), 'USR_1')`,
        ),
      ).rejects.toThrow(/\(tender_id\)/);
    });

    it('is required by the tender: a tender cannot be PUBLISHED without publication facts', async () => {
      const { tender } = await draft();
      await expect(
        w.prisma.client.$executeRawUnsafe(
          `UPDATE "tender" SET "status" = 'PUBLISHED', "procurement_nature" = 'RFP', "visibility" = 'PUBLIC',
             "bid_opening_at" = now(), "bid_closing_at" = now() + interval '1 day'
           WHERE "id" = '${tender.id}'`,
        ),
      ).rejects.toThrow(/ck_tender_publication_complete/);
    });
  });
});

describe('inviting bidders to a restricted tender', () => {
  let w: Wiring;
  const organizations: string[] = [];
  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };

  const restricted = async (visibility: 'PUBLIC' | 'RESTRICTED' | 'NONE' = 'RESTRICTED') => {
    const a = org();
    const project = await approvedProject(w, a);
    const tender = await asAdmin(a, () =>
      w.tenders.create(project.id, {
        title: 'Restricted works',
        scopeOfWork: 'Invited firms only',
        procurementNature: 'INQUIRY',
        ...(visibility === 'NONE' ? {} : { visibility }),
        bidOpeningAt: iso(DAY),
        bidClosingAt: iso(30 * DAY),
      }),
    );
    return { a, tender };
  };

  beforeAll(() => {
    w = wire();
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.close();
  });

  it('invites an organization: ids only on the event, and the owner reads the list', async () => {
    const { a, tender } = await restricted();

    const invited = await asAdmin(a, () =>
      w.publication.invite(tender.id, { organizationId: 'ORG_BIDDER_1' }),
    );

    expect(invited).toMatchObject({ tenderId: tender.id, invitedOrganizationId: 'ORG_BIDDER_1' });
    expect(invited.id).toMatch(/^TIV_/);
    const event = (await outboxFor(w.prisma, a)).find(
      (row) => row.eventName === 'TENDER_BIDDER_INVITED',
    )!;
    expect(event).toMatchObject({ aggregateType: 'Tender', partitionKey: tender.id });
    expect(payloadOf(event)).toMatchObject({
      tenderId: tender.id,
      invitedOrganizationId: 'ORG_BIDDER_1',
      invitedBy: expect.any(String),
    });
    const list = await asAdmin(a, () => w.publication.listInvitations(tender.id, { limit: 25 }));
    expect(list.items.map((item) => item.invitedOrganizationId)).toEqual(['ORG_BIDDER_1']);
  });

  describe('only an organization organization-service knows can be invited', () => {
    const invitations = async (a: string, tenderId: string) =>
      (await asAdmin(a, () => w.publication.listInvitations(tenderId, { limit: 25 }))).items;

    it('refuses a nonexistent organization, writing and counting nothing', async () => {
      const { a, tender } = await restricted();
      w.hierarchy.missing.add('ORG_GHOST');
      try {
        const error = (await asAdmin(a, () =>
          w.publication.invite(tender.id, { organizationId: 'ORG_GHOST' }),
        ).then(
          () => undefined,
          (e: unknown) => e,
        )) as { code?: string; message?: string } | undefined;
        expect(error?.code).toBe('BUSINESS_RULE_VIOLATION');
        expect(error?.message).toContain('ORG_GHOST');
      } finally {
        w.hierarchy.missing.delete('ORG_GHOST');
      }
      expect(await invitations(a, tender.id)).toEqual([]);
      expect(
        (await outboxFor(w.prisma, a)).some((row) => row.eventName === 'TENDER_BIDDER_INVITED'),
      ).toBe(false);
    });

    it('fails closed when organization-service cannot confirm', async () => {
      const { a, tender } = await restricted();
      w.hierarchy.unavailable = true;
      try {
        await expect(
          asAdmin(a, () => w.publication.invite(tender.id, { organizationId: 'ORG_BIDDER_1' })),
        ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
      } finally {
        w.hierarchy.unavailable = false;
      }
      expect(await invitations(a, tender.id)).toEqual([]);
    });

    it('does not ask about an organization for a stranger’s tender: 404 first', async () => {
      const { tender } = await restricted();
      const stranger = org();
      w.hierarchy.unavailable = true;
      try {
        await expect(
          asAdmin(stranger, () =>
            w.publication.invite(tender.id, { organizationId: 'ORG_BIDDER_1' }),
          ),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      } finally {
        w.hierarchy.unavailable = false;
      }
    });
  });

  it('pages the invitations oldest first', async () => {
    const { a, tender } = await restricted();
    for (const id of ['ORG_1', 'ORG_2', 'ORG_3']) {
      await asAdmin(a, () => w.publication.invite(tender.id, { organizationId: id }));
    }
    const page = await asAdmin(a, () => w.publication.listInvitations(tender.id, { limit: 2 }));
    expect(page.items.map((i) => i.invitedOrganizationId)).toEqual(['ORG_1', 'ORG_2']);
    const rest = await asAdmin(a, () =>
      w.publication.listInvitations(tender.id, { limit: 2, cursor: page.nextCursor! }),
    );
    expect(rest.items.map((i) => i.invitedOrganizationId)).toEqual(['ORG_3']);
  });

  it('refuses the same organization twice, the owner itself, and a tender that is not restricted', async () => {
    const { a, tender } = await restricted();
    await asAdmin(a, () => w.publication.invite(tender.id, { organizationId: 'ORG_BIDDER_1' }));

    await expect(
      asAdmin(a, () => w.publication.invite(tender.id, { organizationId: 'ORG_BIDDER_1' })),
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
    await expect(
      asAdmin(a, () => w.publication.invite(tender.id, { organizationId: a })),
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });

    const open = await restricted('PUBLIC');
    await expect(
      asAdmin(open.a, () =>
        w.publication.invite(open.tender.id, { organizationId: 'ORG_BIDDER_1' }),
      ),
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    const undecided = await restricted('NONE');
    await expect(
      asAdmin(undecided.a, () =>
        w.publication.invite(undecided.tender.id, { organizationId: 'ORG_BIDDER_1' }),
      ),
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    // Nothing of the refused attempts was written.
    expect(
      (await asAdmin(a, () => w.publication.listInvitations(tender.id, { limit: 25 }))).items,
    ).toHaveLength(1);
  });

  it('lets exactly one of two simultaneous invitations of the same organization through', async () => {
    const { a, tender } = await restricted();
    const results = await Promise.allSettled([
      asAdmin(a, () => w.publication.invite(tender.id, { organizationId: 'ORG_RACE' })),
      asAdmin(a, () => w.publication.invite(tender.id, { organizationId: 'ORG_RACE' })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason,
    ).toMatchObject({
      code: 'ALREADY_EXISTS',
    });
    expect(
      (await outboxFor(w.prisma, a)).filter((row) => row.eventName === 'TENDER_BIDDER_INVITED'),
    ).toHaveLength(1);
  });

  it('is what makes a restricted tender publishable, and stays possible while it is published', async () => {
    const { a, tender } = await restricted();
    const withCriteria = await asAdmin(a, () =>
      w.criteria.setCriteria(tender.id, { expectedVersion: 1, criteria: WHOLE }),
    );
    await expect(
      asAdmin(a, () =>
        w.publication.publishApproved(tender.id, { expectedVersion: withCriteria.version }),
      ),
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });

    await asAdmin(a, () => w.publication.invite(tender.id, { organizationId: 'ORG_BIDDER_1' }));
    const published = await asAdmin(a, () =>
      w.publication.publishApproved(tender.id, { expectedVersion: withCriteria.version }),
    );
    expect(published.status).toBe('PUBLISHED');

    // An invitation is not a change of the tender: its version stays.
    await asAdmin(a, () => w.publication.invite(tender.id, { organizationId: 'ORG_BIDDER_2' }));
    expect((await asAdmin(a, () => w.tenders.get(tender.id))).version).toBe(published.version);

    await asAdmin(a, () =>
      w.tenders.cancel(tender.id, {
        expectedVersion: published.version,
        reason: 'Funding was withdrawn',
      }),
    );
    await expect(
      asAdmin(a, () => w.publication.invite(tender.id, { organizationId: 'ORG_BIDDER_3' })),
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
  });

  it('stores the owner and the invited organization on the row', async () => {
    const { a, tender } = await restricted();
    const invited = await asAdmin(a, () =>
      w.publication.invite(tender.id, { organizationId: 'ORG_X' }),
    );
    const row = await runUnscoped(
      'reading back what the suite wrote',
      async () => await w.prisma.client.tenderInvitation.findFirst({ where: { id: invited.id } }),
    );
    expect(row).toMatchObject({ organizationId: a, invitedOrganizationId: 'ORG_X' });
  });

  it('database: refuses the owner invited to itself', async () => {
    const { a, tender } = await restricted();
    await expect(
      w.prisma.client.$executeRawUnsafe(
        `INSERT INTO "tender_invitation" ("id", "organization_id", "tender_id", "invited_organization_id",
           "invited_at", "invited_by") VALUES ('TIV_x', '${a}', '${tender.id}', '${a}', now(), 'USR_1')`,
      ),
    ).rejects.toThrow(/ck_invitation_not_self/);
  });
});
