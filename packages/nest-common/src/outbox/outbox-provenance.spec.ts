import { buildOutboxRow, buildRestoredOutboxRow, type OutboxMessageInput } from './outbox';
import {
  captureOutboxProvenance,
  isOutboxProvenance,
  persistedOutboxProvenance,
  restoreOutboxProvenance,
  type OutboxProvenance,
  type PersistedOutboxProvenance,
} from './outbox-provenance';
import {
  createSystemContext,
  runWithContext,
  type RequestContext,
} from '../context/request-context';

/**
 * Provenance across a durable queue (PR #483 r2 N1, r3 F1/F2).
 *
 * F1: an unauthenticated request is its own origin — `anonymous: true` on the
 * envelope — and never reads as background work, which keeps no actor at all.
 * F2: the ordinary build takes no provenance from its input; the one
 * restoration path takes only a provenance the platform issued, reads no
 * ambient context, and requires the tenant.
 */

const ORG_A = 'ORG_01JBQ8Z4K7M2N5P8R1T3V6X9YA';
const ORG_B = 'ORG_01JBQ8Z4K7M2N5P8R1T3V6X9YB';

const verified: RequestContext = {
  correlationId: 'COR_VERIFIED',
  requestId: 'REQ_1',
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  spanId: '00f067aa0ba902b7',
  organizationId: ORG_A,
  organizationIds: [ORG_A],
  userId: 'USR_VERIFIED',
  roles: ['ORGANIZATION_ADMIN'],
  authType: 'USER',
  startedAt: 0,
};
/** An HTTP request on a public route that presented no credential. */
const anonymousRequest: RequestContext = {
  correlationId: 'COR_ANONYMOUS',
  requestId: 'REQ_2',
  organizationIds: [],
  roles: [],
  authType: 'ANONYMOUS',
  startedAt: 0,
};

const input = {
  aggregateType: 'RegistrationRequest',
  aggregateId: 'REG_01JBQ8Z4K7M2N5P8R1T3V6X9Y2',
  eventName: 'REGISTRATION_SUBMITTED',
  topic: 'rasta.identity.v1',
  payload: { registrationId: 'REG_01JBQ8Z4K7M2N5P8R1T3V6X9Y2' },
};
const restoredInput = { ...input, organizationId: ORG_B };
const options = { producer: 'identity-service' };
const envelopeOf = (row: { payload: unknown }) => row.payload as Record<string, unknown>;
const originOf = (row: { payload: unknown }) => {
  const envelope = envelopeOf(row);
  return { actor: envelope.actor, anonymous: envelope.anonymous };
};

describe('the principal of an event: USER, SERVICE, anonymous request, or background work', () => {
  it('in a request, and captured for later, by the same rule', () => {
    const cases: Array<[RequestContext | undefined, Record<string, unknown>]> = [
      [verified, { actor: { type: 'USER', id: 'USR_VERIFIED' }, anonymous: undefined }],
      [
        { ...verified, userId: undefined, callerService: 'fleet-service', authType: 'SERVICE' },
        { actor: { type: 'SERVICE', id: 'fleet-service' }, anonymous: undefined },
      ],
      [anonymousRequest, { actor: undefined, anonymous: true }],
    ];
    for (const [context, expected] of cases) {
      const inRequest = runWithContext(context!, () => buildOutboxRow(input, options));
      expect(originOf(inRequest)).toEqual(expected);

      const captured = runWithContext(context!, () => captureOutboxProvenance());
      const later = buildRestoredOutboxRow(restoredInput, captured, options);
      expect(originOf(later)).toEqual(expected);
      expect(envelopeOf(later).correlationId).toBe(context!.correlationId);
    }
  });

  it('background work is never anonymous: no context, a system context, a consumer’s context', () => {
    const contexts = [
      undefined,
      createSystemContext({ correlationId: 'COR_SWEEP' }),
      createSystemContext({ correlationId: 'COR_SWEEP', organizationId: ORG_A }),
    ];
    for (const context of contexts) {
      const build = () => buildOutboxRow(input, options);
      const row = context ? runWithContext(context, build) : build();
      expect(envelopeOf(row)).not.toHaveProperty('actor');
      expect(envelopeOf(row)).not.toHaveProperty('anonymous');

      const capture = () => captureOutboxProvenance();
      const captured = context ? runWithContext(context, capture) : capture();
      expect(captured.actor).toBeNull();
      expect(persistedOutboxProvenance(captured)).toMatchObject({ actorType: null, actorId: null });
    }
  });

  it('a capture reads the ambient context and takes none as an argument (type-level)', () => {
    const forged = { ...verified, userId: 'USR_SOMEONE_ELSE' };
    // @ts-expect-error — no parameter to hand it another context (PR #483 r3 F2).
    const captured = runWithContext(verified, () => captureOutboxProvenance(forged));
    expect(captured.actor).toEqual({ type: 'USER', id: 'USR_VERIFIED' });
  });

  it('an anonymous origin carries no id anywhere: not on the envelope, not in its stored form', () => {
    const captured = runWithContext(anonymousRequest, () => captureOutboxProvenance());
    expect(captured.actor).toEqual({ type: 'ANONYMOUS' });
    expect(persistedOutboxProvenance(captured)).toEqual({
      actorType: 'ANONYMOUS',
      actorId: null,
      correlationId: 'COR_ANONYMOUS',
    });
    const row = buildRestoredOutboxRow(restoredInput, captured, options);
    expect(envelopeOf(row)).not.toHaveProperty('actor');
    expect(envelopeOf(row).anonymous).toBe(true);
  });
});

describe('buildOutboxRow takes no provenance from its input (PR #483 r3 F2)', () => {
  const chosen = { actor: { type: 'USER', id: 'USR_SOMEONE_ELSE' }, correlationId: 'COR_CHOSEN' };

  it('refuses an input carrying `provenance` — a literal, or even an issued one — and builds nothing', () => {
    const issued = runWithContext({ ...verified, userId: 'USR_SOMEONE_ELSE' }, () =>
      captureOutboxProvenance(),
    );
    for (const provenance of [chosen, { actor: null, correlationId: 'COR_VERIFIED' }, issued]) {
      expect(() =>
        runWithContext(verified, () =>
          buildOutboxRow({ ...input, provenance } as unknown as OutboxMessageInput, options),
        ),
      ).toThrow('takes its provenance from the request context');
    }
  });

  it('never reads an actor, origin, correlation, trace or tenant key an input carries', () => {
    const row = runWithContext(verified, () =>
      buildOutboxRow(
        {
          ...input,
          actor: chosen.actor,
          anonymous: true,
          correlationId: 'COR_CHOSEN',
          traceparent: '00-ffffffffffffffffffffffffffffffff-ffffffffffffffff-01',
          tenantId: ORG_B,
        } as unknown as OutboxMessageInput,
        options,
      ),
    );
    const envelope = envelopeOf(row);
    expect(envelope.actor).toEqual({ type: 'USER', id: 'USR_VERIFIED' });
    expect(envelope).not.toHaveProperty('anonymous');
    expect(envelope.correlationId).toBe('COR_VERIFIED');
    expect(row.correlationId).toBe('COR_VERIFIED');
    expect(envelope.traceparent).toBe(`00-${verified.traceId}-${verified.spanId}-01`);
    // Omitted organizationId: the verified context's tenant, never stripped.
    expect(envelope.tenantId).toBe(ORG_A);
    expect(row.organizationId).toBe(ORG_A);
  });

  it('the ordinary input type has no provenance (type-level)', () => {
    const literal: OutboxMessageInput = {
      ...input,
      // @ts-expect-error — OutboxMessageInput carries no provenance (PR #483 r3 F2).
      provenance: chosen,
    };
    expect(literal).toBeDefined();
  });
});

describe('buildRestoredOutboxRow: the one restoration path', () => {
  const persisted: PersistedOutboxProvenance = {
    actorType: 'USER',
    actorId: 'USR_SUBMITTER',
    correlationId: 'COR_ORIGINAL',
  };

  it('restores a persisted capture exactly, outside any request context', () => {
    const captured = runWithContext(
      { ...verified, userId: 'USR_SUBMITTER', correlationId: 'COR_ORIGINAL' },
      () => captureOutboxProvenance(),
    );
    expect(persistedOutboxProvenance(captured)).toEqual(persisted);

    const row = buildRestoredOutboxRow(restoredInput, restoreOutboxProvenance(persisted), options);
    expect(envelopeOf(row).actor).toEqual({ type: 'USER', id: 'USR_SUBMITTER' });
    expect(envelopeOf(row).correlationId).toBe('COR_ORIGINAL');
    expect(row.correlationId).toBe('COR_ORIGINAL');
    expect(row.headers['x-correlation-id']).toBe('COR_ORIGINAL');
    expect(envelopeOf(row).tenantId).toBe(ORG_B);
  });

  it('reads nothing from an ambient context: not its actor, correlation, trace or tenant', () => {
    const anonymous = restoreOutboxProvenance({
      actorType: 'ANONYMOUS',
      actorId: null,
      correlationId: 'COR_QUEUED',
    });
    const row = runWithContext(verified, () =>
      buildRestoredOutboxRow(restoredInput, anonymous, options),
    );
    const envelope = envelopeOf(row);
    expect(envelope).not.toHaveProperty('actor');
    expect(envelope.anonymous).toBe(true);
    expect(envelope.correlationId).toBe('COR_QUEUED');
    expect(envelope).not.toHaveProperty('traceparent');
    expect(envelope.tenantId).toBe(ORG_B);
  });

  it('refuses a provenance it did not issue: a literal, a copy of an issued one', () => {
    const issued = restoreOutboxProvenance(persisted);
    const forgeries: unknown[] = [
      { actor: { type: 'USER', id: 'USR_SOMEONE_ELSE' }, correlationId: 'COR_CHOSEN' },
      { actor: null, correlationId: 'COR_CHOSEN' },
      { ...issued },
      Object.create(issued),
      null,
    ];
    for (const forged of forgeries) {
      expect(isOutboxProvenance(forged)).toBe(false);
      expect(() =>
        buildRestoredOutboxRow(restoredInput, forged as OutboxProvenance, options),
      ).toThrow('not one the platform captured');
      expect(() => persistedOutboxProvenance(forged as OutboxProvenance)).toThrow(
        'not one the platform captured',
      );
    }
    expect(isOutboxProvenance(issued)).toBe(true);
  });

  it('a literal does not type-check as a provenance (type-level)', () => {
    const literal = () =>
      buildRestoredOutboxRow(
        restoredInput,
        // @ts-expect-error — an OutboxProvenance is issued, never written (PR #483 r3 F2).
        { actor: { type: 'USER', id: 'USR_SOMEONE_ELSE' }, correlationId: 'COR_CHOSEN' },
        options,
      );
    expect(literal).toThrow('not one the platform captured');
  });

  it('cannot drop the tenant: omitted, null or empty is refused', () => {
    const issued = restoreOutboxProvenance(persisted);
    // @ts-expect-error — a restored event states its tenant.
    expect(() => buildRestoredOutboxRow(input, issued, options)).toThrow('states its tenant');
    for (const organizationId of [null, undefined, '']) {
      expect(() =>
        runWithContext(verified, () =>
          buildRestoredOutboxRow({ ...input, organizationId } as never, issued, options),
        ),
      ).toThrow('states its tenant');
    }
  });

  it('takes its provenance as its own argument, never inside the input', () => {
    const issued = restoreOutboxProvenance(persisted);
    expect(() =>
      buildRestoredOutboxRow({ ...restoredInput, provenance: issued } as never, issued, options),
    ).toThrow('its own argument');
  });

  it('refuses a stored provenance the platform could not have captured', () => {
    const bad: unknown[] = [
      { actorType: null, actorId: null, correlationId: '' },
      { actorType: null, actorId: null, correlationId: 'has space' },
      { actorType: null, actorId: null, correlationId: 'x'.repeat(129) },
      { actorType: null, actorId: null, correlationId: 'Bearer eyJhbGciOi.payload.sig\n' },
      { actorType: 'SYSTEM', actorId: 'identity-service', correlationId: 'COR_1' },
      { actorType: 'USER', actorId: null, correlationId: 'COR_1' },
      { actorType: 'USER', actorId: '', correlationId: 'COR_1' },
      { actorType: 'USER', actorId: 'USR 1', correlationId: 'COR_1' },
      { actorType: 'USER', actorId: 'U'.repeat(257), correlationId: 'COR_1' },
      // An anonymous or system origin is given no id — not even a plausible one.
      { actorType: 'ANONYMOUS', actorId: 'USR_1', correlationId: 'COR_1' },
      { actorType: null, actorId: 'USR_1', correlationId: 'COR_1' },
    ];
    for (const row of bad) {
      expect(() => restoreOutboxProvenance(row as PersistedOutboxProvenance)).toThrow(
        'outbox provenance',
      );
    }
  });
});
