import type { EventEnvelope } from '@rasta/contracts';
import {
  isOlderThanApplied,
  originalDelivery,
  readSourcePositions,
  sourcePositionOf,
} from './source-position';

function envelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    eventId: '01JAAAAAAAAAAAAAAAAAAAAAA1',
    eventName: 'ASSET_ACTIVATED',
    eventVersion: 1,
    occurredAt: '2026-09-29T10:00:00.000Z',
    producer: 'asset-service',
    producerVersion: '1.0.0',
    aggregateType: 'Asset',
    aggregateId: 'AST_1',
    correlationId: 'corr',
    payload: {},
    ...overrides,
  } as EventEnvelope;
}

describe('isOlderThanApplied', () => {
  it('nothing applied yet: never older', () => {
    expect(isOlderThanApplied(undefined, sourcePositionOf(envelope()))).toBe(false);
    expect(isOlderThanApplied(null, sourcePositionOf(envelope()))).toBe(false);
  });

  it('sequenced events of one stream compare by sequence, whatever their clocks say', () => {
    const applied = sourcePositionOf(
      envelope({ streamSeq: 7, streamKey: 'AST_1', occurredAt: '2026-09-29T09:00:00.000Z' }),
    );
    const older = sourcePositionOf(
      envelope({ streamSeq: 6, streamKey: 'AST_1', occurredAt: '2026-09-29T11:00:00.000Z' }),
    );
    const newer = sourcePositionOf(
      envelope({ streamSeq: 8, streamKey: 'AST_1', occurredAt: '2026-09-29T08:00:00.000Z' }),
    );
    expect(isOlderThanApplied(applied, older)).toBe(true);
    expect(isOlderThanApplied(applied, newer)).toBe(false);
  });

  it('equal position is not older (idempotent), for sequence and for time', () => {
    const sequenced = sourcePositionOf(envelope({ streamSeq: 3, streamKey: 'AST_1' }));
    expect(isOlderThanApplied(sequenced, sequenced)).toBe(false);
    const timed = sourcePositionOf(envelope());
    expect(isOlderThanApplied(timed, timed)).toBe(false);
  });

  it('unsequenced: occurredAt decides, the event id breaks a tie', () => {
    const applied = sourcePositionOf(envelope({ eventId: '01JBBBBBBBBBBBBBBBBBBBBBB2' }));
    expect(
      isOlderThanApplied(
        applied,
        sourcePositionOf(envelope({ occurredAt: '2026-09-29T09:59:59.999Z' })),
      ),
    ).toBe(true);
    expect(
      isOlderThanApplied(
        applied,
        sourcePositionOf(envelope({ occurredAt: '2026-09-29T10:00:00.001Z' })),
      ),
    ).toBe(false);
    expect(isOlderThanApplied(applied, sourcePositionOf(envelope()))).toBe(true);
    expect(
      isOlderThanApplied(
        sourcePositionOf(envelope()),
        sourcePositionOf(envelope({ eventId: '01JCCCCCCCCCCCCCCCCCCCCCC3' })),
      ),
    ).toBe(false);
  });

  it('sequenced against unsequenced (or another stream key) falls back to time', () => {
    const applied = sourcePositionOf(envelope({ streamSeq: 9, streamKey: 'AST_1' }));
    const older = sourcePositionOf(envelope({ occurredAt: '2026-09-29T09:00:00.000Z' }));
    expect(isOlderThanApplied(applied, older)).toBe(true);
    const otherKey = sourcePositionOf(
      envelope({ streamSeq: 1, streamKey: 'AST_2', occurredAt: '2026-09-29T11:00:00.000Z' }),
    );
    expect(isOlderThanApplied(applied, otherKey)).toBe(false);
  });
});

describe('readSourcePositions', () => {
  it('round-trips a stored position and drops anything malformed', () => {
    const position = sourcePositionOf(envelope({ streamSeq: 2, streamKey: 'AST_1' }));
    expect(readSourcePositions({ 'asset-service': position, bad: 1, worse: { at: 3 } })).toEqual({
      'asset-service': position,
    });
    expect(readSourcePositions(null)).toEqual({});
    expect(readSourcePositions([])).toEqual({});
  });
});

describe('originalDelivery', () => {
  it('reads <topic>.retry as <topic>, keeping the partition', () => {
    expect(originalDelivery({ topic: 'rasta.notification.v1.retry', partition: 3 })).toEqual({
      topic: 'rasta.notification.v1',
      partition: 3,
    });
  });

  it('returns any other delivery as it is', () => {
    const delivery = Object.freeze({ topic: 'rasta.asset.v1', partition: 0 });
    expect(originalDelivery(delivery)).toBe(delivery);
  });
});
