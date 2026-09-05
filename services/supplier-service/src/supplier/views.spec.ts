import { supplierDirectoryViewSchema } from './dto';
import {
  currentlyQualifiedFor,
  DIRECTORY_VIEW_FIELDS,
  toDetailView,
  toDirectoryView,
  type SupplierRow,
} from './views';

/**
 * The directory projection, and what it must never carry.
 *
 * `SearchSuppliers` and `ListQualifiedFor` cross tenant boundaries by design —
 * that is what a directory is for — which makes this projection the boundary
 * itself. A field that leaks into it leaks to every authenticated caller on the
 * platform, through a query that is otherwise entirely correct.
 */

const SUSPENDED_AT = new Date('2026-04-01T00:00:00.000Z');

function row(overrides: Partial<SupplierRow> = {}): SupplierRow {
  return {
    id: 'SUP_1',
    organizationId: 'ORG_1',
    displayName: 'A workshop',
    status: 'ACTIVE',
    registeredBy: 'USR_OWNER',
    registeredAt: new Date('2026-01-01T00:00:00.000Z'),
    capabilities: [{ capability: 'WORKSHOP_SERVICE' }, { capability: 'GOODS_SUPPLY' }],
    qualifications: [
      {
        id: 'QLF_1',
        capability: 'WORKSHOP_SERVICE',
        state: 'APPROVED',
        statement: 'We service heavy machinery',
        submittedBy: 'USR_OWNER',
        submittedAt: new Date('2026-02-01T00:00:00.000Z'),
        decidedBy: 'USR_OPERATOR',
        decidedAt: new Date('2026-03-01T00:00:00.000Z'),
        decisionNote: 'Called the referee listed on the second document',
        evidence: [{ documentId: 'DOC_PRIVATE_LICENCE', label: 'Trade licence' }],
      },
      {
        id: 'QLF_2',
        capability: 'GOODS_SUPPLY',
        state: 'SUBMITTED',
        statement: null,
        submittedBy: 'USR_OWNER',
        submittedAt: new Date('2026-03-15T00:00:00.000Z'),
        decidedBy: null,
        decidedAt: null,
        decisionNote: null,
        evidence: [],
      },
    ],
    suspensions: [],
    ...overrides,
  };
}

const SUSPENDED = row({
  status: 'SUSPENDED',
  suspensions: [
    {
      id: 'SSP_1',
      reason: 'Two buyers reported undelivered orders in the same week',
      suspendedBy: 'USR_OPERATOR',
      suspendedAt: SUSPENDED_AT,
      reinstatedBy: null,
      reinstatedAt: null,
      reinstatementNote: null,
    },
  ],
});

describe('the directory projection carries exactly its declared fields', () => {
  it('emits the declared key set and nothing else', () => {
    // Enumerated rather than spot-checked: a new column on Supplier must not be
    // able to reach the directory by being picked up in a spread.
    expect(Object.keys(toDirectoryView(row())).sort()).toEqual([...DIRECTORY_VIEW_FIELDS].sort());
  });

  it('matches the schema the OpenAPI document publishes, strictly', () => {
    expect(() => supplierDirectoryViewSchema.parse(toDirectoryView(row()))).not.toThrow();
  });
});

describe('what the directory must never leak', () => {
  const view = toDirectoryView(row()) as Record<string, unknown>;
  const serialised = JSON.stringify(view);

  it('carries no evidence document identifier', () => {
    // A document-service id is a handle. Published to strangers, anybody with
    // document-service credentials can try to fetch a supplier's private
    // licence, bypassing this service's authorization entirely.
    expect(serialised).not.toContain('DOC_PRIVATE_LICENCE');
    expect(view).not.toHaveProperty('evidence');
  });

  it("carries no reviewer's decision note", () => {
    expect(serialised).not.toContain('referee');
    expect(view).not.toHaveProperty('decisionNote');
  });

  it('carries no actor identifiers', () => {
    // A directory that named the operator who suspended a competitor would be a
    // directory of platform staff.
    expect(serialised).not.toContain('USR_OPERATOR');
    expect(serialised).not.toContain('USR_OWNER');
    expect(view).not.toHaveProperty('registeredBy');
  });

  it('carries no qualification records at all, decided or otherwise', () => {
    // Not even the ids. "Applied and awaiting review" is not a public fact, and
    // publishing it would let anybody watch a competitor's application.
    expect(view).not.toHaveProperty('qualifications');
    expect(serialised).not.toContain('QLF_');
    expect(serialised).not.toContain('SUBMITTED');
  });

  it('carries no suspension narrative, only the fact', () => {
    const suspendedView = toDirectoryView(SUSPENDED) as Record<string, unknown>;

    // The fact is operationally necessary — marketplace hides offers on it. The
    // narrative is not, and it can be defamatory.
    expect(suspendedView.status).toBe('SUSPENDED');
    expect(suspendedView).not.toHaveProperty('suspensions');
    expect(JSON.stringify(suspendedView)).not.toContain('undelivered');
  });

  it('carries no score or rating field', () => {
    expect(view).not.toHaveProperty('score');
    expect(view).not.toHaveProperty('rating');
    expect(view).not.toHaveProperty('performance');
  });
});

describe('qualifiedFor', () => {
  it('lists only approved capabilities, never submitted ones', () => {
    expect(toDirectoryView(row()).qualifiedFor).toEqual(['WORKSHOP_SERVICE']);
  });

  it('lists claimed capabilities separately, so claiming is never read as qualified', () => {
    const view = toDirectoryView(row());

    expect(view.capabilities).toEqual(['GOODS_SUPPLY', 'WORKSHOP_SERVICE']);
    expect(view.qualifiedFor).toEqual(['WORKSHOP_SERVICE']);
  });

  it('is empty for a suspended supplier', () => {
    // "A suspended supplier cannot be returned as currently qualified."
    expect(toDirectoryView(SUSPENDED).qualifiedFor).toEqual([]);
    expect(currentlyQualifiedFor(SUSPENDED)).toEqual([]);
  });

  it('excludes a rejected qualification', () => {
    const rejected = row({
      qualifications: [
        {
          ...row().qualifications[0],
          state: 'REJECTED',
        },
      ],
    });

    expect(toDirectoryView(rejected).qualifiedFor).toEqual([]);
  });

  it('is sorted, so an equal set never renders as two different payloads', () => {
    const both = row({
      qualifications: [
        { ...row().qualifications[0], capability: 'WORKSHOP_SERVICE' },
        { ...row().qualifications[0], id: 'QLF_3', capability: 'CONTRACTING' },
      ],
    });

    expect(toDirectoryView(both).qualifiedFor).toEqual(['CONTRACTING', 'WORKSHOP_SERVICE']);
  });
});

describe('the detail projection', () => {
  it('contains everything the directory does, so a field cannot be public here and private there', () => {
    const directory = toDirectoryView(row());
    const detail = toDetailView(row()) as Record<string, unknown>;

    for (const [key, value] of Object.entries(directory)) {
      expect(detail[key]).toEqual(value);
    }
  });

  it('adds the private material a permitted reader needs', () => {
    const detail = toDetailView(row());

    expect(detail.registeredBy).toBe('USR_OWNER');
    expect(detail.qualifications[0].decisionNote).toContain('referee');
    expect(detail.qualifications[0].evidence[0].documentId).toBe('DOC_PRIVATE_LICENCE');
  });

  it('shows undecided submissions, which the directory hides', () => {
    const detail = toDetailView(row());

    expect(detail.qualifications.map((q) => q.state)).toEqual(['APPROVED', 'SUBMITTED']);
  });

  it('marks an approval as not current while the supplier is suspended', () => {
    const detail = toDetailView(SUSPENDED);
    const approval = detail.qualifications.find((q) => q.state === 'APPROVED');

    // The approval is untouched — suspension does not revoke it — but it does
    // not count right now, and the view says so rather than leaving the reader
    // to combine two fields.
    expect(approval?.state).toBe('APPROVED');
    expect(approval?.current).toBe(false);
  });

  it('reports the suspension episode as open', () => {
    expect(toDetailView(SUSPENDED).suspensions[0].open).toBe(true);
  });

  it('reports a closed episode as closed and keeps it in the history', () => {
    const reinstated = row({
      status: 'ACTIVE',
      suspensions: [
        {
          ...SUSPENDED.suspensions[0],
          reinstatedBy: 'USR_OPERATOR',
          reinstatedAt: new Date('2026-05-01T00:00:00.000Z'),
          reinstatementNote: 'The two orders were delivered late, not never',
        },
      ],
    });

    const detail = toDetailView(reinstated);

    expect(detail.suspensions).toHaveLength(1);
    expect(detail.suspensions[0].open).toBe(false);
    expect(detail.status).toBe('ACTIVE');
    expect(detail.qualifiedFor).toEqual(['WORKSHOP_SERVICE']);
  });
});

describe('timestamps', () => {
  it('renders every timestamp as ISO-8601 UTC (docs/07 § 7.3)', () => {
    const detail = toDetailView(SUSPENDED);

    expect(detail.registeredAt).toBe('2026-01-01T00:00:00.000Z');
    expect(detail.suspensions[0].suspendedAt).toBe(SUSPENDED_AT.toISOString());
    expect(detail.suspensions[0].reinstatedAt).toBeNull();
  });
});
