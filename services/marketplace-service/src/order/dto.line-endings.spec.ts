import { createSystemContext, runWithContext } from '@rasta/nest-common';
import { TRANSACTION_TEXT_BOUNDS, boundsForAll, type TextBounds } from '@rasta/contracts';
import type { z } from 'zod';
import { IdempotencyStore, targeted } from '../shared/idempotency';
import type { PrismaService } from '../prisma/prisma.service';
import type { MarketplaceEnv } from '../config/env';
import { cancelOrderSchema, raiseDisputeSchema, resolveDisputeSchema } from './dto';

/**
 * PR-806 r1 F1: a browser sends a textarea's line breaks as CRLF. Every order
 * text the saga forwards to economic-service (`TRANSACTION_TEXT_BOUNDS`) is
 * made LF by its schema (`textWithin`) before it is counted, hashed, stored
 * and forwarded — so the CRLF and LF spellings of the same words are accepted
 * at the same length, are one request to the idempotency store, and are one
 * stored and forwarded text.
 *
 * A key stored **before** this change with a CRLF body hashed the CRLF text;
 * its retry now hashes the LF text, and is the generic `409
 * IDEMPOTENCY_KEY_REUSED` (no contents) until the key's retention ends — never
 * a replay of another body and never a second execution. One exception, by
 * design: a CRLF text at exactly the minimum (ten units as sent, nine once LF)
 * is refused `400` before the store is asked — accepting it would forward
 * nine characters economic-service refuses (docs/06 § 6.8).
 */
const DECISION = {
  disputeId: 'DSP_01JZ0000000000000000000000',
  responsibility: 'SUPPLIER',
} as const;

const VARIANTS: readonly [
  string,
  z.ZodType,
  string,
  Record<string, unknown>,
  readonly TextBounds[],
][] = [
  [
    'raise dispute: reason',
    raiseDisputeSchema,
    'reason',
    {},
    [TRANSACTION_TEXT_BOUNDS.disputeReason],
  ],
  ['cancel: reason', cancelOrderSchema, 'reason', {}, [TRANSACTION_TEXT_BOUNDS.closingReason]],
  [
    'resolve SETTLE: resolution',
    resolveDisputeSchema,
    'resolution',
    { ...DECISION, outcome: 'SETTLE' },
    [TRANSACTION_TEXT_BOUNDS.disputeResolution],
  ],
  [
    'resolve REFUND: resolution',
    resolveDisputeSchema,
    'resolution',
    { ...DECISION, outcome: 'REFUND' },
    [TRANSACTION_TEXT_BOUNDS.disputeResolution, TRANSACTION_TEXT_BOUNDS.closingReason],
  ],
];

const ENV = {
  MARKETPLACE_IDEMPOTENCY_TTL_HOURS: 24,
  MARKETPLACE_IDEMPOTENCY_CLAIM_LEASE_SECONDS: 60,
} as MarketplaceEnv;
const uniqueViolation = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
const asOperator = <T>(fn: () => Promise<T>) =>
  runWithContext(
    createSystemContext({
      correlationId: 'unit-line-endings',
      organizationId: 'ORG-UNIT',
      authType: 'USER',
      userId: 'USR_OPERATOR',
    }),
    fn,
  );

/** A store whose key `K` was completed by a request that hashed `storedHash`. */
function storeHolding(storedHash: string): IdempotencyStore {
  const idempotencyKey = {
    create: jest.fn().mockRejectedValue(uniqueViolation),
    findUnique: jest.fn().mockResolvedValue({
      requestHash: storedHash,
      state: 'COMPLETED',
      responseStatus: 200,
      responseBody: { id: 'ORD_1', status: 'CANCELLING' },
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    }),
  };
  const tx = { idempotencyKey, $queryRaw: jest.fn().mockResolvedValue([]) };
  const prisma = {
    client: { idempotencyKey, $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)) },
  } as unknown as PrismaService;
  return new IdempotencyStore(prisma, ENV);
}

const hashOf = (body: unknown) =>
  asOperator(() =>
    Promise.resolve(new IdempotencyStore(null as unknown as PrismaService, ENV).hash(body)),
  );

describe.each(VARIANTS)('%s — line endings (PR-806 r1, F1)', (_name, schema, field, rest, into) => {
  const { max } = boundsForAll(...into);
  // `max + 1` units as sent, `max` once LF.
  const crlf = `${'x'.repeat(max - 2)}\r\ny`;
  const lf = `${'x'.repeat(max - 2)}\ny`;
  const body = (text: string) => ({ ...rest, [field]: text });

  it('accepts the CRLF and LF spellings at the maximum, and refuses one more', () => {
    expect(schema.safeParse(body(crlf)).success).toBe(true);
    expect(schema.safeParse(body(lf)).success).toBe(true);
    expect(schema.safeParse(body(`x${crlf}`)).success).toBe(false);
  });

  it('parses both into one LF value — the one stored and forwarded', () => {
    expect(schema.parse(body(crlf))).toEqual(schema.parse(body(lf)));
    expect((schema.parse(body(` ${crlf}\r\n`)) as Record<string, string>)[field]).toBe(lf);
    expect((schema.parse(body('ab\rcd\r\nefgh\n')) as Record<string, string>)[field]).toBe(
      'ab\ncd\nefgh',
    );
  });

  it('replays under one key whichever spelling was sent first', async () => {
    for (const [first, retry] of [
      [crlf, lf],
      [lf, crlf],
    ]) {
      const stored = await hashOf(targeted('ORD_1', schema.parse(body(first))));
      const claim = await asOperator(() =>
        storeHolding(stored).claim(
          'POST /v1/orders/:id/x',
          'K',
          targeted('ORD_1', schema.parse(body(retry))),
        ),
      );
      expect(claim).toMatchObject({ kind: 'REPLAY', status: 200 });
    }
  });

  it('answers a key stored before the change with a CRLF body with the generic 409 IDEMPOTENCY_KEY_REUSED', async () => {
    // What the previous release hashed: the trimmed text as sent, CRLF kept
    // (within its as-sent bounds, so that release accepted it).
    const sent = 'the supplier\r\nsent nothing at all';
    const storedBefore = await hashOf(targeted('ORD_1', body(sent)));
    await expect(
      asOperator(() =>
        storeHolding(storedBefore).claim(
          'POST /v1/orders/:id/x',
          'K',
          targeted('ORD_1', schema.parse(body(sent))),
        ),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    // A body stored before with LF only is unchanged by the change: replayed.
    const lfBefore = await hashOf(targeted('ORD_1', body(sent.replace('\r\n', '\n'))));
    await expect(
      asOperator(() =>
        storeHolding(lfBefore).claim(
          'POST /v1/orders/:id/x',
          'K',
          targeted('ORD_1', schema.parse(body(sent))),
        ),
      ),
    ).resolves.toMatchObject({ kind: 'REPLAY' });
  });
});

describe('a CRLF text at exactly the minimum — nine characters once LF', () => {
  // Ten units as sent, the previous release's minimum; refused here, because
  // its LF form is what would be forwarded, and economic-service refuses nine
  // characters under either count — the saga would stop with the funds held.
  const atMinWithCrlf = '1234\r\n5678';
  it.each([
    ['raise dispute: reason', () => raiseDisputeSchema.safeParse({ reason: atMinWithCrlf })],
    [
      'resolve SETTLE: resolution',
      () =>
        resolveDisputeSchema.safeParse({
          ...DECISION,
          outcome: 'SETTLE',
          resolution: atMinWithCrlf,
        }),
    ],
  ])('%s is refused', (_name, parse) => {
    expect(parse().success).toBe(false);
  });
});
