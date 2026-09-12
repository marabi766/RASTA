import { ZodError } from 'zod';
import type { EventEnvelope } from '@rasta/contracts';
import type { EventDelivery } from '@rasta/nest-common';
import {
  isOrganizationProjectionEvent,
  ORGANIZATION_PROJECTION_EVENTS,
  ORGANIZATION_TOPIC,
  toOrganizationProjection,
} from './organization-projection';

/**
 * The consumer-side contract for the three organization events that carry the
 * hierarchy `UNION_ADMIN` scoping is decided from.
 *
 * Two properties are asserted here and both are security properties rather than
 * mapping conveniences:
 *
 *   **Topic-gated.** The topic comes from broker delivery metadata, never from
 *   the envelope. A producer must not be able to reshape another service's
 *   authorization projection by publishing an `ORGANIZATION_MOVED` to a topic it
 *   happens to own.
 *
 *   **Fail-closed on malformed input.** A payload missing a field this
 *   projection reads raises rather than resolving to `undefined`. An
 *   `undefined` parent would make the organization a hierarchy root, which is
 *   the broadening failure the whole design exists to prevent.
 */

const OCCURRED_AT = '2026-09-05T10:00:00.000Z';

function envelope(eventName: string, payload: unknown): EventEnvelope {
  return {
    eventId: '01JORGPROJ0000000000000001',
    eventName,
    eventVersion: 1,
    occurredAt: OCCURRED_AT,
    producer: 'organization-service',
    producerVersion: '1.0.0',
    aggregateType: 'Organization',
    aggregateId: 'ORG-1',
    tenantId: 'ORG-1',
    correlationId: 'corr-1',
    payload,
  } as EventEnvelope;
}

const from = (topic: string): EventDelivery =>
  ({ topic, partition: 0, offset: '1' }) as unknown as EventDelivery;

const ORG_DELIVERY = from(ORGANIZATION_TOPIC);

const CREATED_PAYLOAD = {
  organizationId: 'ORG-CHILD',
  status: 'ACTIVE',
  parentId: 'ORG-UNION',
  path: 'ORG-ROOT/ORG-UNION/ORG-CHILD',
  depth: 2,
};

const MOVED_PAYLOAD = {
  organizationId: 'ORG-CHILD',
  newParentId: 'ORG-OTHER-UNION',
  newPath: 'ORG-ROOT/ORG-OTHER-UNION/ORG-CHILD',
};

const STATUS_PAYLOAD = {
  organizationId: 'ORG-UNION',
  newStatus: 'SUSPENDED',
  affectedIds: ['ORG-UNION', 'ORG-CHILD'],
};

describe('which deliveries the projection reads', () => {
  it.each(Object.values(ORGANIZATION_PROJECTION_EVENTS))(
    'accepts %s from the organization topic',
    (eventName) => {
      expect(isOrganizationProjectionEvent(envelope(eventName, {}), ORG_DELIVERY)).toBe(true);
    },
  );

  it('ignores an organization event that arrived on another topic', () => {
    // The control that matters: a producer naming an event it does not own must
    // not be able to write another service's authorization projection.
    expect(
      isOrganizationProjectionEvent(
        envelope(ORGANIZATION_PROJECTION_EVENTS.MOVED, MOVED_PAYLOAD),
        from('rasta.asset.v1'),
      ),
    ).toBe(false);
    expect(
      toOrganizationProjection(
        envelope(ORGANIZATION_PROJECTION_EVENTS.MOVED, MOVED_PAYLOAD),
        from('rasta.asset.v1'),
      ),
    ).toBeNull();
  });

  it('ignores an organization event this projection has no use for', () => {
    // `ORGANIZATION_UPDATED` and friends still produce an audit row; they just
    // say nothing about the hierarchy.
    expect(
      toOrganizationProjection(envelope('ORGANIZATION_UPDATED', { name: 'x' }), ORG_DELIVERY),
    ).toBeNull();
  });
});

describe('ORGANIZATION_CREATED', () => {
  it('projects the parent link, the diagnostics and the status', () => {
    expect(
      toOrganizationProjection(
        envelope(ORGANIZATION_PROJECTION_EVENTS.CREATED, CREATED_PAYLOAD),
        ORG_DELIVERY,
      ),
    ).toEqual({
      kind: 'CREATED',
      organizationId: 'ORG-CHILD',
      parentOrganizationId: 'ORG-UNION',
      hierarchyPath: 'ORG-ROOT/ORG-UNION/ORG-CHILD',
      hierarchyDepth: 2,
      status: 'ACTIVE',
      observedAt: new Date(OCCURRED_AT),
    });
  });

  it('keeps a genuine root as a root', () => {
    const projection = toOrganizationProjection(
      envelope(ORGANIZATION_PROJECTION_EVENTS.CREATED, {
        ...CREATED_PAYLOAD,
        parentId: null,
        depth: 0,
      }),
      ORG_DELIVERY,
    );
    expect(projection).toMatchObject({ parentOrganizationId: null });
  });

  it('reads a blank parent as no parent rather than as an empty identifier', () => {
    expect(
      toOrganizationProjection(
        envelope(ORGANIZATION_PROJECTION_EVENTS.CREATED, { ...CREATED_PAYLOAD, parentId: '  ' }),
        ORG_DELIVERY,
      ),
    ).toMatchObject({ parentOrganizationId: null });
  });

  it('accepts a field the producer added that this consumer does not read', () => {
    // Tolerant of growth, strict about what it uses. A producer adding a field
    // must not dead-letter this consumer.
    expect(
      toOrganizationProjection(
        envelope(ORGANIZATION_PROJECTION_EVENTS.CREATED, { ...CREATED_PAYLOAD, name: 'Yazd' }),
        ORG_DELIVERY,
      ),
    ).toMatchObject({ organizationId: 'ORG-CHILD' });
  });

  it.each([['organizationId'], ['status'], ['parentId'], ['path'], ['depth']])(
    'refuses a payload missing %s rather than defaulting it',
    (missing) => {
      const payload: Record<string, unknown> = { ...CREATED_PAYLOAD };
      delete payload[missing];
      expect(() =>
        toOrganizationProjection(
          envelope(ORGANIZATION_PROJECTION_EVENTS.CREATED, payload),
          ORG_DELIVERY,
        ),
      ).toThrow(ZodError);
    },
  );

  it('refuses an organization that claims to be its own parent', () => {
    // A one-node cycle, which the upward subtree walk would otherwise meet. The
    // database refuses to store one too; caught here so the failure names a
    // field instead of aborting the ingest transaction.
    expect(() =>
      toOrganizationProjection(
        envelope(ORGANIZATION_PROJECTION_EVENTS.CREATED, {
          ...CREATED_PAYLOAD,
          parentId: CREATED_PAYLOAD.organizationId,
        }),
        ORG_DELIVERY,
      ),
    ).toThrow(ZodError);
  });

  it('refuses an identifier that does not fit the column', () => {
    // Truncating a key would produce a *different* organization, which is the
    // one value worth refusing rather than bounding.
    expect(() =>
      toOrganizationProjection(
        envelope(ORGANIZATION_PROJECTION_EVENTS.CREATED, {
          ...CREATED_PAYLOAD,
          organizationId: 'O'.repeat(129),
        }),
        ORG_DELIVERY,
      ),
    ).toThrow(ZodError);
  });

  it('bounds an oversized path rather than dead-lettering the event', () => {
    // A path is a diagnostic. Refusing one long enough to raise `22001` would
    // turn a cosmetic upstream value into a lost audit record.
    const projection = toOrganizationProjection(
      envelope(ORGANIZATION_PROJECTION_EVENTS.CREATED, {
        ...CREATED_PAYLOAD,
        path: 'p'.repeat(4000),
      }),
      ORG_DELIVERY,
    );
    expect(projection).toMatchObject({ hierarchyPath: 'p'.repeat(2048) });
  });

  it('carries no payload value in the error it raises', () => {
    // Zod reports field paths, not values. A rejected payload is still a
    // payload, and the consumer logs only what this error carries.
    try {
      toOrganizationProjection(
        envelope(ORGANIZATION_PROJECTION_EVENTS.CREATED, {
          organizationId: 'ORG-SECRET-NAME',
          status: 'ACTIVE',
        }),
        ORG_DELIVERY,
      );
      throw new Error('expected a validation failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ZodError);
      expect(JSON.stringify((error as ZodError).issues)).not.toContain('ORG-SECRET-NAME');
    }
  });
});

describe('ORGANIZATION_MOVED', () => {
  it('projects the new parent and says nothing about status or depth', () => {
    // A move that wrote a null status would remove the organization from its
    // own union's subtree — a denial nobody asked for.
    expect(
      toOrganizationProjection(
        envelope(ORGANIZATION_PROJECTION_EVENTS.MOVED, MOVED_PAYLOAD),
        ORG_DELIVERY,
      ),
    ).toEqual({
      kind: 'MOVED',
      organizationId: 'ORG-CHILD',
      parentOrganizationId: 'ORG-OTHER-UNION',
      hierarchyPath: 'ORG-ROOT/ORG-OTHER-UNION/ORG-CHILD',
      observedAt: new Date(OCCURRED_AT),
    });
  });

  it('projects a move to the top of the hierarchy', () => {
    expect(
      toOrganizationProjection(
        envelope(ORGANIZATION_PROJECTION_EVENTS.MOVED, { ...MOVED_PAYLOAD, newParentId: null }),
        ORG_DELIVERY,
      ),
    ).toMatchObject({ parentOrganizationId: null });
  });

  it.each([['organizationId'], ['newParentId'], ['newPath']])(
    'refuses a payload missing %s',
    (missing) => {
      const payload: Record<string, unknown> = { ...MOVED_PAYLOAD };
      delete payload[missing];
      expect(() =>
        toOrganizationProjection(
          envelope(ORGANIZATION_PROJECTION_EVENTS.MOVED, payload),
          ORG_DELIVERY,
        ),
      ).toThrow(ZodError);
    },
  );

  it('refuses a move that makes an organization its own parent', () => {
    expect(() =>
      toOrganizationProjection(
        envelope(ORGANIZATION_PROJECTION_EVENTS.MOVED, {
          ...MOVED_PAYLOAD,
          newParentId: MOVED_PAYLOAD.organizationId,
        }),
        ORG_DELIVERY,
      ),
    ).toThrow(ZodError);
  });
});

describe('ORGANIZATION_STATUS_CHANGED', () => {
  it('projects the status and the cascade', () => {
    expect(
      toOrganizationProjection(
        envelope(ORGANIZATION_PROJECTION_EVENTS.STATUS_CHANGED, STATUS_PAYLOAD),
        ORG_DELIVERY,
      ),
    ).toEqual({
      kind: 'STATUS_CHANGED',
      organizationId: 'ORG-UNION',
      status: 'SUSPENDED',
      affectedOrganizationIds: ['ORG-UNION', 'ORG-CHILD'],
      observedAt: new Date(OCCURRED_AT),
    });
  });

  it('includes the subject even when the producer left it out of the cascade', () => {
    // A status change that did not change the subject's own status is not a
    // status change, and inferring it costs nothing.
    expect(
      toOrganizationProjection(
        envelope(ORGANIZATION_PROJECTION_EVENTS.STATUS_CHANGED, {
          ...STATUS_PAYLOAD,
          affectedIds: ['ORG-CHILD'],
        }),
        ORG_DELIVERY,
      ),
    ).toMatchObject({ affectedOrganizationIds: ['ORG-UNION', 'ORG-CHILD'] });
  });

  it('de-duplicates the cascade', () => {
    expect(
      toOrganizationProjection(
        envelope(ORGANIZATION_PROJECTION_EVENTS.STATUS_CHANGED, {
          ...STATUS_PAYLOAD,
          affectedIds: ['ORG-CHILD', 'ORG-CHILD', 'ORG-UNION'],
        }),
        ORG_DELIVERY,
      ),
    ).toMatchObject({ affectedOrganizationIds: ['ORG-UNION', 'ORG-CHILD'] });
  });

  it('drops a blank or oversized cascade entry rather than truncating it', () => {
    // Truncating an identifier would apply the status to a *different*
    // organization — the one mistake worth dropping a value for.
    expect(
      toOrganizationProjection(
        envelope(ORGANIZATION_PROJECTION_EVENTS.STATUS_CHANGED, {
          ...STATUS_PAYLOAD,
          affectedIds: ['   ', 'O'.repeat(200), 'ORG-CHILD'],
        }),
        ORG_DELIVERY,
      ),
    ).toMatchObject({ affectedOrganizationIds: ['ORG-UNION', 'ORG-CHILD'] });
  });

  it.each([['organizationId'], ['newStatus'], ['affectedIds']])(
    'refuses a payload missing %s',
    (missing) => {
      const payload: Record<string, unknown> = { ...STATUS_PAYLOAD };
      delete payload[missing];
      expect(() =>
        toOrganizationProjection(
          envelope(ORGANIZATION_PROJECTION_EVENTS.STATUS_CHANGED, payload),
          ORG_DELIVERY,
        ),
      ).toThrow(ZodError);
    },
  );

  it('records a status this service has never heard of', () => {
    // The vocabulary belongs to another service. Failing to record a status
    // because it is new would stall the projection on a value that is not
    // wrong, only unfamiliar.
    expect(
      toOrganizationProjection(
        envelope(ORGANIZATION_PROJECTION_EVENTS.STATUS_CHANGED, {
          ...STATUS_PAYLOAD,
          newStatus: 'PENDING_REVIEW',
        }),
        ORG_DELIVERY,
      ),
    ).toMatchObject({ status: 'PENDING_REVIEW' });
  });
});
