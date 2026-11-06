import { z } from 'zod';
import { createSystemContext, runWithContext } from '@rasta/nest-common';
import { TRANSACTION_TEXT_BOUNDS, type TextBounds } from '@rasta/contracts';
import { canonicalBodyPipe, canonicalForm } from '../shared/canonical';
import { IdempotencyStore, hashRequestBody, targeted } from '../shared/idempotency';
import type { PrismaService } from '../prisma/prisma.service';
import type { EconomicEnv } from '../config/env';
import {
  cancelTransactionSchema,
  disputeTransactionSchema,
  refundTransactionSchema,
  resolveDisputeSchema,
} from './dto';

/**
 * Contract equality (FU-134): each transaction body that another service fills
 * with its users' text accepts exactly the lengths `TRANSACTION_TEXT_BOUNDS`
 * states — the table marketplace-service validates the same text with when it
 * accepts it. Probed through the real schemas at both edges, so a body whose
 * bounds differ from its table entry — a literal that drifted, or the wrong
 * entry read — fails (a literal equal to the entry passes until either moves).
 */
const BODIES: readonly [string, z.ZodType, string, TextBounds][] = [
  ['refund', refundTransactionSchema, 'reason', TRANSACTION_TEXT_BOUNDS.closingReason],
  ['cancel', cancelTransactionSchema, 'reason', TRANSACTION_TEXT_BOUNDS.closingReason],
  ['dispute', disputeTransactionSchema, 'reason', TRANSACTION_TEXT_BOUNDS.disputeReason],
  [
    'resolve-dispute',
    resolveDisputeSchema,
    'resolution',
    TRANSACTION_TEXT_BOUNDS.disputeResolution,
  ],
];

describe.each(BODIES)('POST /v1/transactions/{id}/%s', (_name, schema, field, bounds) => {
  const parses = (length: number) => schema.safeParse({ [field]: 'x'.repeat(length) }).success;

  it(`${field}: accepts exactly ${bounds.min}..${bounds.max} characters`, () => {
    expect([
      parses(bounds.min - 1),
      parses(bounds.min),
      parses(bounds.max),
      parses(bounds.max + 1),
    ]).toEqual([false, true, true, false]);
  });

  it(`${field}: counts the trimmed text`, () => {
    expect(schema.safeParse({ [field]: ` ${'x'.repeat(bounds.max)}\r\n` }).success).toBe(true);
  });
});

/**
 * PR-806 r1 F1: line endings. Each body counts its text with LF line endings
 * (`keptTextWithin`), as marketplace-service counts what it forwards — so the
 * CRLF spelling of a text at the maximum is no longer refused one unit early.
 * The text is executed and stored **as sent** (FU-115: storing LF waits for
 * its readers-first rollout); the LF form is what the idempotency hash also
 * sees (#747's canonical hash), so both spellings replay under one key.
 */
const uniqueViolation = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
const asTenant = <T>(fn: () => Promise<T>) =>
  runWithContext(createSystemContext({ correlationId: 'unit-lf', organizationId: 'ORG-UNIT' }), fn);

/** A store whose key `K` holds a completed request with these hashes. */
function storedAs(requestHash: string, canonicalHash: string | null) {
  const idempotencyKey = {
    create: jest.fn().mockRejectedValue(uniqueViolation),
    findUnique: jest.fn().mockResolvedValue({
      requestHash,
      canonicalHash,
      actorHash: null,
      state: 'COMPLETED',
      responseStatus: 200,
      responseBody: { id: 'TXN_1' },
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    }),
  };
  const tx = { idempotencyKey, $queryRaw: jest.fn().mockResolvedValue([]) };
  const prisma = {
    client: { idempotencyKey, $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)) },
  } as unknown as PrismaService;
  return new IdempotencyStore(prisma, {
    ECONOMIC_IDEMPOTENCY_TTL_HOURS: 24,
    ECONOMIC_IDEMPOTENCY_CLAIM_LEASE_SECONDS: 60,
  } as unknown as EconomicEnv);
}

describe.each(BODIES)(
  'POST /v1/transactions/{id}/%s — line endings',
  (_name, schema, field, bounds) => {
    // `max + 1` units as sent, `max` once LF.
    const crlf = `${'x'.repeat(bounds.max - 2)}\r\ny`;
    const lf = `${'x'.repeat(bounds.max - 2)}\ny`;
    const piped = (text: string) =>
      canonicalBodyPipe(schema).transform({ [field]: text }, { type: 'body' }) as Record<
        string,
        string
      >;
    /** The release before this change: the same bounds, counted as sent. */
    const previousRelease = z
      .object({ [field]: z.string().trim().min(bounds.min).max(bounds.max) })
      .strict();

    it(`${field}: accepts the CRLF and LF spellings at the maximum, refuses one more`, () => {
      expect(previousRelease.safeParse({ [field]: crlf }).success).toBe(false);
      expect(schema.safeParse({ [field]: crlf }).success).toBe(true);
      expect(schema.safeParse({ [field]: lf }).success).toBe(true);
      expect(schema.safeParse({ [field]: `x${crlf}` }).success).toBe(false);
    });

    it(`${field}: executes the text as sent, and hashes its LF form too`, () => {
      const dto = piped(crlf);
      expect(dto[field]).toBe(crlf);
      expect(canonicalForm(dto)).toEqual({ [field]: lf });
      expect(canonicalForm(piped(lf))).toBeUndefined();
    });

    it(`${field}: replays under one key whichever spelling was sent first`, async () => {
      const fingerprints = (text: string) => {
        const dto = piped(text);
        const asSent = hashRequestBody(targeted('TXN_1', dto));
        const canonical = canonicalForm(targeted('TXN_1', dto));
        return { asSent, canonical: canonical === undefined ? asSent : hashRequestBody(canonical) };
      };
      for (const [first, retry] of [
        [crlf, lf],
        [lf, crlf],
      ]) {
        const stored = fingerprints(first);
        const store = storedAs(stored.asSent, stored.canonical);
        await expect(
          asTenant(() => store.claim('POST /x', 'K', targeted('TXN_1', piped(retry)))),
        ).resolves.toMatchObject({ kind: 'REPLAY', status: 200 });
      }
    });

    it(`${field}: a key stored before the change with a CRLF body still replays its unchanged retry`, async () => {
      // What the previous release validated, executed and hashed: the text as
      // sent; a release before #747 wrote no canonical hash.
      const sent = 'the supplier\r\nsent nothing at all';
      const before = previousRelease.parse({ [field]: sent });
      const store = storedAs(hashRequestBody(targeted('TXN_1', before)), null);
      await expect(
        asTenant(() => store.claim('POST /x', 'K', targeted('TXN_1', piped(sent)))),
      ).resolves.toMatchObject({ kind: 'REPLAY', status: 200 });
    });
  },
);
