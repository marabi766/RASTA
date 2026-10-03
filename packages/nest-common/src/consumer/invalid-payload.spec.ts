import { DLQ_REASONS } from '@rasta/contracts';
import { z } from 'zod';
import { UnprocessableEventError } from './event-consumer';
import { invalidPayloadError, missingTenantError } from './invalid-payload';

/**
 * Audit L7-26: a known event with a malformed payload is dead-lettered, and
 * what the dead letter says about it is identifiers and closed codes — never
 * a value from the payload, never a key the payload chose (S-09).
 */
const SENTINEL = 'SENTINEL-national-id-0012345678';

const schema = z
  .object({
    assetId: z.string().min(1),
    readings: z.array(z.object({ hours: z.string() })).optional(),
    extra: z.record(z.string(), z.number()).optional(),
    kind: z.enum(['A', 'B']).optional(),
  })
  .passthrough();
const fields = Object.keys(schema.shape);
const envelope = { eventName: 'USAGE_RECORDED', eventId: 'EVT-1' };

function refusal(payload: unknown): UnprocessableEventError {
  const parsed = schema.safeParse(payload);
  if (parsed.success) throw new Error('expected the payload to fail');
  return invalidPayloadError(envelope, parsed.error, fields);
}

describe('invalidPayloadError', () => {
  it('is a VALIDATION_FAILED refusal naming the event, the field path and the zod code', () => {
    const error = refusal({ organizationId: 'ORG-1' });

    expect(error).toBeInstanceOf(UnprocessableEventError);
    expect(error.reason).toBe(DLQ_REASONS.VALIDATION_FAILED);
    expect(error.message).toBe(
      'USAGE_RECORDED EVT-1 payload fails its schema: assetId invalid_type',
    );
  });

  it('never repeats a payload value, even where zod quotes the value received', () => {
    const error = refusal({ assetId: '', kind: SENTINEL, readings: [{ hours: 7 }] });

    expect(error.message).not.toContain(SENTINEL);
    expect(error.message).toContain('kind invalid_enum_value');
    // A nested name is shown only when the caller lists it among `fields`.
    expect(error.message).toContain('readings.0.* invalid_type');
    expect(error.message).toContain('assetId too_small');
  });

  it('shows a key the payload supplied as `*`, not by its name', () => {
    const error = refusal({ assetId: 'AST-1', extra: { [SENTINEL]: 'not-a-number' } });

    expect(error.message).not.toContain(SENTINEL);
    expect(error.message).toContain('extra.* invalid_type');
  });

  it('names at most five issues and counts the rest', () => {
    const many = z.object(
      Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`f${i}`, z.string()])),
    );
    const parsed = many.safeParse({});
    if (parsed.success) throw new Error('expected the payload to fail');

    const error = invalidPayloadError(envelope, parsed.error, Object.keys(many.shape));

    expect(error.message).toMatch(/f4 invalid_type; and 2 more$/);
    expect(error.message).not.toContain('f5');
  });
});

describe('missingTenantError', () => {
  it('is a VALIDATION_FAILED refusal naming the event only', () => {
    const error = missingTenantError(envelope);

    expect(error).toBeInstanceOf(UnprocessableEventError);
    expect(error.reason).toBe(DLQ_REASONS.VALIDATION_FAILED);
    expect(error.message).toBe('USAGE_RECORDED EVT-1 carries no tenant');
  });
});
