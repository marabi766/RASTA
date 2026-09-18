import { buildOutboxRow } from './outbox';
import { runWithContext, type RequestContext } from '../context/request-context';

/**
 * An outbox row's tenant: omitted means "the request's", `null` means "none".
 *
 * The distinction exists for a genuinely platform-scoped event produced inside
 * a request whose user has *selected* a tenant — an audit correction of a
 * platform-scoped record, issued by an administrator acting for their own
 * organization (AUD-003 correction). Falling back to that tenant would file the event
 * under an organization it has nothing to do with.
 */

const context: RequestContext = {
  correlationId: 'COR-OUTBOX',
  requestId: 'REQ-OUTBOX',
  organizationId: 'ORG-CONTEXT',
  organizationIds: ['ORG-CONTEXT'],
  userId: 'USR-1',
  roles: ['SYSTEM_ADMIN'],
  authType: 'USER',
  startedAt: 0,
};

const build = (organizationId?: string | null) =>
  runWithContext(context, () =>
    buildOutboxRow(
      {
        aggregateType: 'Thing',
        aggregateId: 'T-1',
        eventName: 'THING_HAPPENED',
        topic: 'rasta.thing.v1',
        payload: { a: 1 },
        ...(organizationId !== undefined ? { organizationId } : {}),
      },
      { producer: 'test-service' },
    ),
  );

const tenantOf = (row: ReturnType<typeof build>): unknown =>
  (row.payload as { tenantId?: unknown }).tenantId;

describe('buildOutboxRow — the tenant of an event', () => {
  it('falls back to the request context when the tenant is omitted, as before', () => {
    const row = build();

    expect(row.organizationId).toBe('ORG-CONTEXT');
    expect(tenantOf(row)).toBe('ORG-CONTEXT');
  });

  it('uses an explicit tenant over the context', () => {
    const row = build('ORG-EXPLICIT');

    expect(row.organizationId).toBe('ORG-EXPLICIT');
    expect(tenantOf(row)).toBe('ORG-EXPLICIT');
  });

  it('treats an explicit null as no tenant at all, never the context’s', () => {
    const row = build(null);

    expect(row.organizationId).toBeNull();
    expect(row.payload).not.toHaveProperty('tenantId');
  });
});
