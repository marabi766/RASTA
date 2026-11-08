import { TRANSACTION_TEXT_BOUNDS, boundsForAll, type TextBounds } from '@rasta/contracts';
import {
  cancelOrderSchema,
  raiseDisputeSchema,
  REFUND_RESOLUTION_BOUNDS,
  REFUND_RESOLUTION_OUT_OF_BOUNDS,
  resolveDisputeSchema,
} from './dto';

/**
 * Every order-command text the saga later sends to economic-service, and every
 * economic body it goes into (FU-134). A text is accepted here only at lengths
 * every one of those bodies accepts, so the money path never meets a refusal
 * the command could have given — the refund refused with the funds held and
 * the order `CANCELLING`.
 *
 *   raise dispute `reason`      → POST …/dispute `reason`
 *   cancel `reason`             → order.cancellationReason → POST …/refund | …/cancel `reason`
 *   resolve SETTLE `resolution` → POST …/resolve-dispute `resolution`
 *   resolve REFUND `resolution` → POST …/resolve-dispute `resolution`
 *                                 + order.cancellationReason → POST …/refund | …/cancel `reason`
 *
 * economic-service's own spec (`dto.text-bounds.spec.ts`) pins its bodies to
 * the same table, so the two sides are equal through it.
 */
const DECISION = {
  disputeId: 'DSP_01JZ0000000000000000000000',
  responsibility: 'SUPPLIER',
} as const;

const FORWARDED: readonly [string, (text: string) => boolean, readonly TextBounds[]][] = [
  [
    'raise dispute: reason',
    (reason) => raiseDisputeSchema.safeParse({ reason }).success,
    [TRANSACTION_TEXT_BOUNDS.disputeReason],
  ],
  [
    'cancel: reason',
    (reason) => cancelOrderSchema.safeParse({ reason }).success,
    [TRANSACTION_TEXT_BOUNDS.closingReason],
  ],
  [
    'resolve SETTLE: resolution',
    (resolution) =>
      resolveDisputeSchema.safeParse({ ...DECISION, outcome: 'SETTLE', resolution }).success,
    [TRANSACTION_TEXT_BOUNDS.disputeResolution],
  ],
  [
    'resolve REFUND: resolution',
    (resolution) =>
      resolveDisputeSchema.safeParse({ ...DECISION, outcome: 'REFUND', resolution }).success,
    [TRANSACTION_TEXT_BOUNDS.disputeResolution, TRANSACTION_TEXT_BOUNDS.closingReason],
  ],
];

describe.each(FORWARDED)('%s', (_name, accepts, destinations) => {
  const { min, max } = boundsForAll(...destinations);
  const at = (length: number) => accepts('ب'.repeat(length));

  it('accepts exactly the lengths every economic body it is sent into accepts', () => {
    expect([at(min - 1), at(min), at(max), at(max + 1)]).toEqual([false, true, true, false]);
  });

  it('counts code points of the trimmed text, as economic-service does', () => {
    // One code point, two UTF-16 units each: `max` of them fit, one more does not.
    expect(accepts(`  ${'😀'.repeat(max)}\r\n`)).toBe(true);
    expect(accepts('😀'.repeat(max + 1))).toBe(false);
  });
});

describe('a REFUND decision the refund could not carry (FU-134)', () => {
  const over = 'ب'.repeat(TRANSACTION_TEXT_BOUNDS.closingReason.max + 1);

  it('is bounded by the refund reason, the smaller of the two bodies', () => {
    expect(REFUND_RESOLUTION_BOUNDS).toEqual({
      min: TRANSACTION_TEXT_BOUNDS.disputeResolution.min,
      max: TRANSACTION_TEXT_BOUNDS.closingReason.max,
    });
  });

  it('is refused on resolution, with the closed message and nothing of the input', () => {
    const parsed = resolveDisputeSchema.safeParse({
      ...DECISION,
      outcome: 'REFUND',
      resolution: over,
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toEqual([
      expect.objectContaining({ path: ['resolution'], message: REFUND_RESOLUTION_OUT_OF_BOUNDS }),
    ]);
    expect(REFUND_RESOLUTION_OUT_OF_BOUNDS).toBe(
      "A REFUND resolution is also the refund's reason: between 10 and 500 characters",
    );
  });

  it('is the same text a SETTLE may carry', () => {
    expect(
      resolveDisputeSchema.safeParse({ ...DECISION, outcome: 'SETTLE', resolution: over }).success,
    ).toBe(true);
  });
});
