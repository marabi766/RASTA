import { isRastaError, runWithContext, type RequestContext } from '@rasta/nest-common';
import type { Logger } from '@rasta/logging';
import { AuditVerificationService } from './audit.verification.service';
import { computeRecordHash, type AuditChainKey } from './audit.chain';
import type {
  AuditChainHeadRow,
  AuditChainMarker,
  AuditChainRow,
  AuditChainSegment,
  AuditRepository,
} from './audit.repository';
import type { HashableAuditRecord } from './audit.canonical';
import { CANONICAL_VERSION } from './audit.canonical';
import type { AuditVerifyQuery } from './audit.query.dto';
import { auditChainVerificationSchema } from './audit.verification.view';
import {
  auditChainVerificationFailuresTotal,
  auditChainVerificationsTotal,
} from '../observability/metrics';
import type { AuditEnv } from '../config/env';

/**
 * The verification endpoint, asserted against chains built with the real hash
 * function.
 *
 * Nothing here stubs `computeRecordHash`. Every chain below is linked by the
 * same code the writer uses, so "this window verifies" means the walk actually
 * recomputed SHA-256 over canonical bytes and agreed — and a tampered record is
 * tampered in the way an attacker would tamper with it, by changing a column
 * and leaving the stored digest behind.
 *
 * Four properties are under test, and each is a specific way a verification
 * endpoint tells a comfortable lie:
 *
 *   **A null link is not automatically harmless.** Below the chain's recorded
 *   segment start it is a pre-AUD-003 row; at or above it, it is a link that
 *   was removed. A verifier that cannot tell them apart reports integrity
 *   damage as history.
 *
 *   **"The head is ahead of you" is a claim.** A head past the verified window
 *   is legitimate only when a real, correctly linked successor exists. Deleting
 *   a month's final record must not produce `VALID`.
 *
 *   **The ceiling is checked against the work.** The contiguous chain interval
 *   the walk reads, not the number of records whose `occurredAt` lands in the
 *   window — the two differ by orders of magnitude on a sparse out-of-order
 *   window, which is exactly the request that costs the most.
 *
 *   **A refusal costs zero queries**, and a divergence is the only thing that
 *   moves the failure counter.
 */

const UNION = 'ORG-UNION';
const CHILD = 'ORG-CHILD';
const SIBLING = 'ORG-SIBLING';

const AUGUST = '2026-08';
const SEPTEMBER = '2026-09';

const ENV = { AUDIT_MAX_VERIFICATION_RECORDS: 100_000 } as AuditEnv;

// -----------------------------------------------------------------------------
// Chains, built by the real writer's rules
// -----------------------------------------------------------------------------

/** One record of a chain, before its link is computed. */
function record(overrides: Partial<HashableAuditRecord>): HashableAuditRecord {
  return {
    id: '01JAUDIT0000000000000000',
    occurredAt: new Date('2026-08-01T12:00:00.000Z'),
    recordedAt: new Date('2026-08-01T12:00:01.000Z'),
    actorType: 'USER',
    actorId: 'USR-1',
    actorRoles: [],
    organizationId: UNION,
    action: 'asset.decommissioned',
    resourceType: 'Asset',
    resourceId: 'AST-1',
    outcome: 'SUCCESS',
    errorCode: null,
    reason: null,
    changes: null,
    occurrenceCount: 1,
    sourceService: 'asset-service',
    sourceServiceVersion: '1.0.0',
    sourceEventId: '01JEVENT0000000000000001',
    sourceEventName: 'ASSET_DECOMMISSIONED',
    sourceTopic: 'rasta.asset.v1',
    sourceIp: null,
    sourceUserAgent: null,
    correlationId: 'corr-1',
    causationId: null,
    traceparent: null,
    sourceStreamSeq: null,
    sequenceNo: 1n,
    correctionOf: null,
    ...overrides,
  };
}

interface ChainState {
  rows: AuditChainRow[];
  head: AuditChainHeadRow | null;
}

interface RecordSpec {
  /** Day of the month this record occurred on. Out-of-order values are the point. */
  readonly day: number;
  /** A row written before the chain existed: no link, never backfilled. */
  readonly legacy?: boolean;
}

/**
 * A chain, linked exactly as `AuditRepository.ingest` links one.
 *
 * `sequenceNo` ascends with insertion order and `occurredAt` comes from the
 * spec, so a caller can build the case the design tolerates and the naive
 * implementation gets wrong: a record that occurred early and arrived late.
 */
function buildChain(options: {
  organizationId: string | null;
  month: string;
  records: RecordSpec[];
  startSequence?: bigint;
}): ChainState {
  const rows: AuditChainRow[] = [];
  let previous: Uint8Array | null = null;
  let chained = 0;
  let firstSequenceNo: bigint | null = null;
  let head: AuditChainHeadRow | null = null;

  options.records.forEach((spec, index) => {
    const sequenceNo = (options.startSequence ?? 1n) + BigInt(index);
    const day = String(spec.day).padStart(2, '0');
    const base = record({
      id: `01JAUDIT${options.month.replace('-', '')}${String(index).padStart(6, '0')}`,
      organizationId: options.organizationId,
      occurredAt: new Date(`${options.month}-${day}T12:00:00.000Z`),
      recordedAt: new Date(`${options.month}-${day}T12:00:01.000Z`),
      sequenceNo,
    });

    if (spec.legacy === true) {
      // Written before AUD-003: both columns null, and nothing ever fills them.
      rows.push({ ...base, recordHash: null, previousHash: null });
      return;
    }

    const recordHash = computeRecordHash(base, previous);
    rows.push({ ...base, recordHash, previousHash: previous });

    chained += 1;
    firstSequenceNo ??= sequenceNo;
    head = {
      chainLength: BigInt(chained),
      headHash: recordHash,
      headEventId: base.id,
      headSequenceNo: sequenceNo,
      firstSequenceNo,
    };
    previous = recordHash;
  });

  // A month nothing has been chained in has no head row at all, which is the
  // true state of a pre-AUD-003 month.
  return { rows, head };
}

const days = (count: number): RecordSpec[] =>
  Array.from({ length: count }, (_unused, index) => ({ day: index + 1 }));

// -----------------------------------------------------------------------------
// The repository, in memory, recording every call
// -----------------------------------------------------------------------------

const keyOf = (key: AuditChainKey): string =>
  `${key.scope}|${key.organizationKey}|${key.chainMonth}`;

interface Stub {
  repository: AuditRepository;
  calls: { method: string; key?: AuditChainKey }[];
  subtreeCalls: [string, string][];
  methodCalls: (method: string) => { method: string; key?: AuditChainKey }[];
}

function stubRepository(options: {
  chains?: Record<string, ChainState>;
  descendants?: string[];
  segment?: (key: AuditChainKey) => AuditChainSegment | null;
}): Stub {
  const chains = new Map(Object.entries(options.chains ?? {}));
  const calls: { method: string; key?: AuditChainKey }[] = [];
  const subtreeCalls: [string, string][] = [];

  const rowsOf = (key: AuditChainKey): AuditChainRow[] => chains.get(keyOf(key))?.rows ?? [];

  const marker = (row: AuditChainRow): AuditChainMarker => ({
    id: row.id,
    sequenceNo: row.sequenceNo,
    recordHash: row.recordHash,
    previousHash: row.previousHash,
  });

  const repository = {
    isWithinProjectedSubtree: async (root: string, target: string): Promise<boolean> => {
      subtreeCalls.push([root, target]);
      return (options.descendants ?? []).includes(target);
    },

    chainSegment: async (
      key: AuditChainKey,
      from: Date,
      to: Date,
    ): Promise<AuditChainSegment | null> => {
      calls.push({ method: 'chainSegment', key });
      if (options.segment !== undefined) return options.segment(key);

      const monthStart = new Date(`${key.chainMonth}T00:00:00.000Z`);
      const lower = from.getTime() > monthStart.getTime() ? from : monthStart;
      const inRange = rowsOf(key).filter(
        (row) =>
          row.occurredAt.getTime() >= lower.getTime() && row.occurredAt.getTime() <= to.getTime(),
      );
      if (inRange.length === 0) return null;

      const positions = inRange.map((row) => row.sequenceNo);
      const firstSequenceNo = positions.reduce((min, at) => (at < min ? at : min));
      const lastSequenceNo = positions.reduce((max, at) => (at > max ? at : max));

      return {
        firstSequenceNo,
        lastSequenceNo,
        recordsInRange: inRange.length,
        // What the walk will actually read: the whole contiguous interval,
        // including anything that arrived out of order between the two ends.
        walkLength: rowsOf(key).filter(
          (row) => row.sequenceNo >= firstSequenceNo && row.sequenceNo <= lastSequenceNo,
        ).length,
      };
    },

    chainHead: async (key: AuditChainKey): Promise<AuditChainHeadRow | null> => {
      calls.push({ method: 'chainHead', key });
      return chains.get(keyOf(key))?.head ?? null;
    },

    chainPredecessor: async (
      key: AuditChainKey,
      firstSequenceNo: bigint,
    ): Promise<{ sequenceNo: bigint; recordHash: Uint8Array | null } | null> => {
      calls.push({ method: 'chainPredecessor', key });
      const before = rowsOf(key).filter((row) => row.sequenceNo < firstSequenceNo);
      const last = before.at(-1);
      return last === undefined
        ? null
        : { sequenceNo: last.sequenceNo, recordHash: last.recordHash };
    },

    chainPage: async (
      key: AuditChainKey,
      bounds: { firstSequenceNo: bigint; lastSequenceNo: bigint },
      afterSequenceNo: bigint | null,
      limit: number,
    ): Promise<AuditChainRow[]> => {
      calls.push({ method: 'chainPage', key });
      const lower = afterSequenceNo === null ? bounds.firstSequenceNo : afterSequenceNo + 1n;
      return rowsOf(key)
        .filter((row) => row.sequenceNo >= lower && row.sequenceNo <= bounds.lastSequenceNo)
        .slice(0, limit);
    },

    chainRecordAt: async (
      key: AuditChainKey,
      sequenceNo: bigint,
    ): Promise<AuditChainMarker | null> => {
      calls.push({ method: 'chainRecordAt', key });
      const row = rowsOf(key).find((candidate) => candidate.sequenceNo === sequenceNo);
      return row === undefined ? null : marker(row);
    },

    chainSuccessor: async (
      key: AuditChainKey,
      afterSequenceNo: bigint,
    ): Promise<AuditChainMarker | null> => {
      calls.push({ method: 'chainSuccessor', key });
      const row = rowsOf(key).find((candidate) => candidate.sequenceNo > afterSequenceNo);
      return row === undefined ? null : marker(row);
    },
  } as unknown as AuditRepository;

  return {
    repository,
    calls,
    subtreeCalls,
    methodCalls: (method: string) => calls.filter((call) => call.method === method),
  };
}

// -----------------------------------------------------------------------------
// The caller, the query and the logger
// -----------------------------------------------------------------------------

const logLines: string[] = [];

const capturingLogger = {
  info: (message: string) => logLines.push(message),
  warn: (message: string) => logLines.push(message),
  error: (message: string) => logLines.push(message),
  debug: (message: string) => logLines.push(message),
} as unknown as Logger;

function context(overrides: Partial<RequestContext>): RequestContext {
  return {
    requestId: 'req-1',
    correlationId: 'corr-1',
    authType: 'USER',
    roles: [],
    startedAt: 0,
    ...overrides,
  } as RequestContext;
}

const as = <T>(overrides: Partial<RequestContext>, fn: () => Promise<T>): Promise<T> =>
  runWithContext(context(overrides), fn);

const query = (overrides: Partial<AuditVerifyQuery> = {}): AuditVerifyQuery => ({
  from: new Date('2026-08-01T00:00:00.000Z'),
  to: new Date('2026-08-31T23:59:59.999Z'),
  scope: 'ORGANIZATION',
  ...overrides,
});

const serviceFor = (stub: Stub, env: AuditEnv = ENV): AuditVerificationService =>
  new AuditVerificationService(stub.repository, capturingLogger, env);

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    if (isRastaError(error)) return error.code;
    return `NOT_A_PLATFORM_ERROR: ${String(error)}`;
  }
  return 'NO_ERROR';
}

/** One label combination's counter value, or zero if it never moved. */
async function counterValue(
  counter: typeof auditChainVerificationFailuresTotal | typeof auditChainVerificationsTotal,
  labels: Record<string, string>,
): Promise<number> {
  const metric = await counter.get();
  return (
    metric.values
      .filter((value) => {
        const found = value.labels as Record<string, string | number | undefined>;
        return Object.entries(labels).every(([name, expected]) => found[name] === expected);
      })
      .reduce((total, value) => total + value.value, 0) ?? 0
  );
}

beforeEach(() => {
  logLines.length = 0;
  auditChainVerificationFailuresTotal.reset();
  auditChainVerificationsTotal.reset();
});

// -----------------------------------------------------------------------------

describe('a window whose chain holds', () => {
  const chains = {
    [`ORGANIZATION|${UNION}|2026-08-01`]: buildChain({
      organizationId: UNION,
      month: AUGUST,
      records: days(5),
    }),
  };

  it('recomputes every link and reports VALID', async () => {
    const stub = stubRepository({ chains });
    const result = await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
      serviceFor(stub).verify(query()),
    );

    expect(result.status).toBe('VALID');
    expect(result.valid).toBe(true);
    expect(result.recordsInRange).toBe(5);
    expect(result.recordsVerified).toBe(5);
    expect(result.unchainedRecords).toBe(0);
    expect(result.firstDivergence).toBeNull();
  });

  it('returns a response the published schema accepts', async () => {
    // The service parses its own result before returning; this asserts the
    // object a caller receives is the parsed one and still satisfies every
    // cross-field rule.
    const stub = stubRepository({ chains });
    const result = await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
      serviceFor(stub).verify(query()),
    );

    expect(auditChainVerificationSchema.safeParse(result).success).toBe(true);
  });

  it('states the canonical version the recomputation used', async () => {
    // A verification result means nothing without the encoding it was produced
    // under: an old result and a new one would otherwise be answers to
    // different questions with no way to tell.
    const stub = stubRepository({ chains });
    const result = await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
      serviceFor(stub).verify(query()),
    );

    expect(result.canonicalVersion).toBe(CANONICAL_VERSION);
  });

  it('echoes the window and the chain it verified', async () => {
    const stub = stubRepository({ chains });
    const result = await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
      serviceFor(stub).verify(query()),
    );

    expect(result.scope).toBe('ORGANIZATION');
    expect(result.organizationId).toBe(UNION);
    expect(result.from).toBe('2026-08-01T00:00:00.000Z');
    expect(result.months).toHaveLength(1);
    expect(result.months[0]?.month).toBe(AUGUST);
  });

  it('says it was not seeded when the window starts at the segment start', async () => {
    // The weaker of the two statements, published rather than hidden: nothing
    // outside the window vouched for the first link.
    const stub = stubRepository({ chains });
    const result = await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
      serviceFor(stub).verify(query()),
    );

    expect(result.months[0]?.seededFromPredecessor).toBe(false);
  });

  it('publishes no hash and no payload anywhere in the response', async () => {
    const stub = stubRepository({ chains });
    const result = await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
      serviceFor(stub).verify(query()),
    );

    const body = JSON.stringify(result);
    expect(body).not.toContain('Hash');
    expect(body).not.toContain('hash');
    expect(body).not.toContain('changes');
  });
});

describe('a window that starts mid-chain', () => {
  const chains = {
    [`ORGANIZATION|${UNION}|2026-08-01`]: buildChain({
      organizationId: UNION,
      month: AUGUST,
      records: days(5),
    }),
  };

  it('seeds the first link from the record before the window', async () => {
    // Without the seed, a window can only ever say "these links agree with each
    // other" — which a forger who rewrote a contiguous run would also satisfy.
    const stub = stubRepository({ chains });
    const result = await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
      serviceFor(stub).verify(
        query({
          from: new Date('2026-08-03T00:00:00.000Z'),
          to: new Date('2026-08-05T23:59:59.999Z'),
        }),
      ),
    );

    expect(result.status).toBe('VALID');
    expect(result.months[0]?.seededFromPredecessor).toBe(true);
    expect(result.recordsVerified).toBe(3);
  });

  it('stays valid when the head is genuinely ahead and a real successor links to the window', async () => {
    // The case the tail check must not break while closing the deleted-tail
    // one: a mid-range window over a chain that legitimately continues.
    const stub = stubRepository({ chains });
    const result = await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
      serviceFor(stub).verify(
        query({
          from: new Date('2026-08-02T00:00:00.000Z'),
          to: new Date('2026-08-03T23:59:59.999Z'),
        }),
      ),
    );

    expect(result.status).toBe('VALID');
    expect(stub.methodCalls('chainSuccessor')).toHaveLength(1);
  });
});

describe('a window with nothing in it', () => {
  it('reports EMPTY rather than valid', async () => {
    // "Nothing happened" must not be able to stand in for a proof.
    const stub = stubRepository({ chains: {} });
    const result = await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
      serviceFor(stub).verify(query()),
    );

    expect(result.status).toBe('EMPTY');
    expect(result.valid).toBe(false);
    expect(result.recordsInRange).toBe(0);
    expect(stub.methodCalls('chainPage')).toHaveLength(0);
  });
});

describe('a window that spans months', () => {
  const chains = {
    [`ORGANIZATION|${UNION}|2026-08-01`]: buildChain({
      organizationId: UNION,
      month: AUGUST,
      records: days(3),
    }),
    [`ORGANIZATION|${UNION}|2026-09-01`]: buildChain({
      organizationId: UNION,
      month: SEPTEMBER,
      records: days(2),
      startSequence: 100n,
    }),
  };

  const wide = query({
    from: new Date('2026-08-01T00:00:00.000Z'),
    to: new Date('2026-09-30T23:59:59.999Z'),
  });

  it('verifies each month as its own chain and sums the totals', async () => {
    // One chain per (organization, month) is the ADR's scope decision; a
    // response that treated two months as one chain would be asserting links
    // that were never written.
    const stub = stubRepository({ chains });
    const result = await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
      serviceFor(stub).verify(wide),
    );

    expect(result.status).toBe('VALID');
    expect(result.months.map((month) => month.month)).toEqual([AUGUST, SEPTEMBER]);
    expect(result.recordsVerified).toBe(5);
    expect(result.months[1]?.seededFromPredecessor).toBe(false);
  });

  it('reads each month under its own chain key and never widens one', async () => {
    const stub = stubRepository({ chains });
    await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
      serviceFor(stub).verify(wide),
    );

    for (const call of stub.calls) {
      expect(call.key?.scope).toBe('ORGANIZATION');
      expect(call.key?.organizationKey).toBe(UNION);
      expect(['2026-08-01', '2026-09-01']).toContain(call.key?.chainMonth);
    }
  });

  it('stops at the first divergent month and does not walk the later one', async () => {
    // A divergence is an incident, and the runbook's first instruction is to
    // freeze rather than to keep reading.
    const damaged = buildChain({ organizationId: UNION, month: AUGUST, records: days(3) });
    const target = damaged.rows[1];
    if (target !== undefined) damaged.rows[1] = { ...target, action: 'asset.recommissioned' };

    const stub = stubRepository({
      chains: { ...chains, [`ORGANIZATION|${UNION}|2026-08-01`]: damaged },
    });
    const result = await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
      serviceFor(stub).verify(wide),
    );

    expect(result.status).toBe('DIVERGENT');
    expect(result.months).toHaveLength(1);
    expect(result.firstDivergence?.month).toBe(AUGUST);

    const september = stub
      .methodCalls('chainPage')
      .filter((call) => call.key?.chainMonth === '2026-09-01');
    expect(september).toHaveLength(0);
  });
});

describe('a record that no longer hashes to its own link', () => {
  it('reports RECORD_HASH_MISMATCH at that record', async () => {
    // The realistic tamper: a column edited in place, the stored digest left
    // behind. Nothing but a recomputation catches it.
    const chain = buildChain({ organizationId: UNION, month: AUGUST, records: days(4) });
    const target = chain.rows[2];
    if (target !== undefined) chain.rows[2] = { ...target, outcome: 'FAILURE' };

    const stub = stubRepository({ chains: { [`ORGANIZATION|${UNION}|2026-08-01`]: chain } });
    const result = await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
      serviceFor(stub).verify(query()),
    );

    expect(result.status).toBe('DIVERGENT');
    expect(result.valid).toBe(false);
    expect(result.firstDivergence?.reason).toBe('RECORD_HASH_MISMATCH');
    expect(result.firstDivergence?.auditEventId).toBe(chain.rows[2]?.id);
    expect(result.firstDivergence?.sequenceNo).toBe('3');
  });
});

describe('a link that points at the wrong predecessor', () => {
  it('reports PREVIOUS_HASH_MISMATCH', async () => {
    const chain = buildChain({ organizationId: UNION, month: AUGUST, records: days(4) });
    const target = chain.rows[2];
    if (target !== undefined) {
      chain.rows[2] = { ...target, previousHash: new Uint8Array(32).fill(0xcd) };
    }

    const stub = stubRepository({ chains: { [`ORGANIZATION|${UNION}|2026-08-01`]: chain } });
    const result = await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
      serviceFor(stub).verify(query()),
    );

    expect(result.firstDivergence?.reason).toBe('PREVIOUS_HASH_MISMATCH');
  });
});

describe('a null link, which means two opposite things', () => {
  it('reads a record below the segment start as unverifiable legacy', async () => {
    // Written before AUD-003. Counted, reported, and never called valid —
    // nothing backfills it and nothing pretends it verified.
    const chain = buildChain({
      organizationId: UNION,
      month: AUGUST,
      records: [
        { day: 1, legacy: true },
        { day: 2, legacy: true },
        { day: 3 },
        { day: 4 },
        { day: 5 },
      ],
    });

    const stub = stubRepository({ chains: { [`ORGANIZATION|${UNION}|2026-08-01`]: chain } });
    const result = await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
      serviceFor(stub).verify(query()),
    );

    expect(result.status).toBe('UNVERIFIABLE_LEGACY');
    expect(result.valid).toBe(false);
    expect(result.unchainedRecords).toBe(2);
    expect(result.recordsVerified).toBe(3);
    expect(result.firstDivergence).toBeNull();
  });

  it('reads a record at or after the segment start as DIVERGENT', async () => {
    // The attack the segment start exists to close: strip a chained record's
    // link and have the verifier describe integrity damage as history.
    const chain = buildChain({ organizationId: UNION, month: AUGUST, records: days(4) });
    const target = chain.rows[2];
    if (target !== undefined) {
      chain.rows[2] = { ...target, recordHash: null, previousHash: null };
    }

    const stub = stubRepository({ chains: { [`ORGANIZATION|${UNION}|2026-08-01`]: chain } });
    const result = await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
      serviceFor(stub).verify(query()),
    );

    expect(result.status).toBe('DIVERGENT');
    expect(result.firstDivergence?.reason).toBe('MISSING_CHAIN_LINK');
    expect(result.firstDivergence?.sequenceNo).toBe('3');
  });

  it('reads a whole unchained month as legacy, with no head to contradict it', async () => {
    const chain = buildChain({
      organizationId: UNION,
      month: AUGUST,
      records: [
        { day: 1, legacy: true },
        { day: 2, legacy: true },
      ],
    });
    expect(chain.head).toBeNull();

    const stub = stubRepository({ chains: { [`ORGANIZATION|${UNION}|2026-08-01`]: chain } });
    const result = await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
      serviceFor(stub).verify(query()),
    );

    expect(result.status).toBe('UNVERIFIABLE_LEGACY');
    expect(result.unchainedRecords).toBe(2);
    expect(stub.methodCalls('chainSuccessor')).toHaveLength(0);
  });
});

describe('a head that cannot be taken at its word', () => {
  it('refuses to call a month valid when its final record is gone', async () => {
    // The failure a "the head is ahead of you, so carry on" verifier reports
    // as VALID: delete the last record of a month, leave the head alone.
    const chain = buildChain({ organizationId: UNION, month: AUGUST, records: days(5) });
    chain.rows.pop();

    const stub = stubRepository({ chains: { [`ORGANIZATION|${UNION}|2026-08-01`]: chain } });
    const result = await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
      serviceFor(stub).verify(query()),
    );

    expect(result.status).toBe('DIVERGENT');
    expect(result.firstDivergence?.reason).toBe('CHAIN_HEAD_MISMATCH');
  });

  it('reports CHAIN_TAIL_MISSING when the records between the window and the head are gone', async () => {
    // The head still names a record that exists, so the cheap check passes;
    // what is missing is everything between the window and it, which only the
    // successor's link reveals.
    const chain = buildChain({ organizationId: UNION, month: AUGUST, records: days(5) });
    chain.rows.splice(2, 2);

    const stub = stubRepository({ chains: { [`ORGANIZATION|${UNION}|2026-08-01`]: chain } });
    const result = await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
      serviceFor(stub).verify(
        query({
          from: new Date('2026-08-01T00:00:00.000Z'),
          to: new Date('2026-08-02T23:59:59.999Z'),
        }),
      ),
    );

    expect(result.status).toBe('DIVERGENT');
    expect(result.firstDivergence?.reason).toBe('CHAIN_TAIL_MISSING');
  });

  it('reports a head that names a different digest than the record it points at', async () => {
    const chain = buildChain({ organizationId: UNION, month: AUGUST, records: days(3) });
    if (chain.head !== null)
      chain.head = { ...chain.head, headHash: new Uint8Array(32).fill(0x99) };

    const stub = stubRepository({ chains: { [`ORGANIZATION|${UNION}|2026-08-01`]: chain } });
    const result = await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
      serviceFor(stub).verify(query()),
    );

    expect(result.firstDivergence?.reason).toBe('CHAIN_HEAD_MISMATCH');
  });

  it('reports a head left behind the records it should describe', async () => {
    // The rewind: a head moved back lets the next legitimate write re-link onto
    // an older tip, forking the chain without touching a committed audit row.
    const chain = buildChain({ organizationId: UNION, month: AUGUST, records: days(4) });
    const second = chain.rows[1];
    if (chain.head !== null && second !== undefined) {
      chain.head = {
        ...chain.head,
        chainLength: 2n,
        headHash: second.recordHash,
        headEventId: second.id,
        headSequenceNo: second.sequenceNo,
      };
    }

    const stub = stubRepository({ chains: { [`ORGANIZATION|${UNION}|2026-08-01`]: chain } });
    const result = await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
      serviceFor(stub).verify(query()),
    );

    expect(result.firstDivergence?.reason).toBe('CHAIN_HEAD_MISMATCH');
  });

  it('reports linked records that no head describes at all', async () => {
    const chain = buildChain({ organizationId: UNION, month: AUGUST, records: days(3) });
    chain.head = null;

    const stub = stubRepository({ chains: { [`ORGANIZATION|${UNION}|2026-08-01`]: chain } });
    const result = await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
      serviceFor(stub).verify(query()),
    );

    expect(result.firstDivergence?.reason).toBe('CHAIN_HEAD_MISMATCH');
  });

  it('reports a head whose count disagrees with a whole-segment walk', async () => {
    // A record removed anywhere inside a segment shows up here even if its
    // neighbours' links were rewritten to close the gap.
    const chain = buildChain({ organizationId: UNION, month: AUGUST, records: days(3) });
    if (chain.head !== null) chain.head = { ...chain.head, chainLength: 9n };

    const stub = stubRepository({ chains: { [`ORGANIZATION|${UNION}|2026-08-01`]: chain } });
    const result = await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
      serviceFor(stub).verify(query()),
    );

    expect(result.firstDivergence?.reason).toBe('CHAIN_LENGTH_MISMATCH');
  });
});

describe('the ceiling is checked against the work, not against the question', () => {
  // Two records two days apart in `occurredAt`, with thirty-eight records that
  // arrived out of order sitting between them in chain order. ADR-053 § 8
  // tolerates exactly this, which is why the preflight cannot count the window.
  const sparse = buildChain({
    organizationId: UNION,
    month: AUGUST,
    records: [{ day: 1 }, ...Array.from({ length: 38 }, () => ({ day: 20 })), { day: 2 }],
  });
  const chains = { [`ORGANIZATION|${UNION}|2026-08-01`]: sparse };

  const narrow = query({
    from: new Date('2026-08-01T00:00:00.000Z'),
    to: new Date('2026-08-03T23:59:59.999Z'),
  });

  it('refuses the walk before a single record is read', async () => {
    const stub = stubRepository({ chains });
    const service = serviceFor(stub, { ...ENV, AUDIT_MAX_VERIFICATION_RECORDS: 10 } as AuditEnv);

    const code = await codeOf(() =>
      as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () => service.verify(narrow)),
    );

    expect(code).toBe('VALIDATION_FAILED');
    expect(stub.methodCalls('chainPage')).toHaveLength(0);
    expect(stub.methodCalls('chainHead')).toHaveLength(0);
  });

  it('would have waved the same request through on the count the caller asked about', async () => {
    // The negative control. Two records land in the window and forty are in the
    // interval the walk reads: a preflight on `recordsInRange` accepts exactly
    // the request that costs the most.
    const stub = stubRepository({ chains });
    const segment = await stub.repository.chainSegment(
      { scope: 'ORGANIZATION', organizationKey: UNION, chainMonth: '2026-08-01' },
      narrow.from,
      narrow.to,
    );

    expect(segment?.recordsInRange).toBe(2);
    expect(segment?.walkLength).toBe(40);
  });

  it('names the ceiling and the walk it refused', async () => {
    const stub = stubRepository({ chains });
    const service = serviceFor(stub, { ...ENV, AUDIT_MAX_VERIFICATION_RECORDS: 10 } as AuditEnv);

    try {
      await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () => service.verify(narrow));
      throw new Error('expected a refusal');
    } catch (error) {
      const details = JSON.stringify(isRastaError(error) ? error.details : []);
      expect(details).toContain('40');
      expect(details).toContain('AUDIT_MAX_VERIFICATION_RECORDS');
    }
  });

  it('accepts the same window under a ceiling above the walk', async () => {
    const stub = stubRepository({ chains });
    const result = await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
      serviceFor(stub, { ...ENV, AUDIT_MAX_VERIFICATION_RECORDS: 1_000 } as AuditEnv).verify(
        narrow,
      ),
    );

    // The out-of-order records inside the interval are walked and verified;
    // only the two that fall in the window are reported as asked about.
    expect(result.status).toBe('VALID');
    expect(result.recordsInRange).toBe(2);
    expect(result.recordsVerified).toBe(40);
  });

  it('still stops mid-walk if the planned count turns out to be short', async () => {
    // Defence in depth: the preflight is an aggregate taken before the walk, so
    // a record inserted between the two would otherwise walk past the ceiling.
    const stub = stubRepository({
      chains,
      segment: () => ({
        firstSequenceNo: 1n,
        lastSequenceNo: 40n,
        recordsInRange: 2,
        walkLength: 1,
      }),
    });

    const code = await codeOf(() =>
      as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
        serviceFor(stub, { ...ENV, AUDIT_MAX_VERIFICATION_RECORDS: 3 } as AuditEnv).verify(narrow),
      ),
    );

    expect(code).toBe('VALIDATION_FAILED');
    expect(stub.methodCalls('chainPage').length).toBeGreaterThan(0);
  });
});

describe('who may verify which chain', () => {
  const unionChain = {
    [`ORGANIZATION|${UNION}|2026-08-01`]: buildChain({
      organizationId: UNION,
      month: AUGUST,
      records: days(2),
    }),
  };

  it('lets a SYSTEM_ADMIN verify the platform chain', async () => {
    const platform = buildChain({ organizationId: null, month: AUGUST, records: days(2) });
    const stub = stubRepository({ chains: { [`PLATFORM||2026-08-01`]: platform } });

    const result = await as({ roles: ['SYSTEM_ADMIN'] }, () =>
      serviceFor(stub).verify(query({ scope: 'PLATFORM' })),
    );

    expect(result.status).toBe('VALID');
    expect(result.organizationId).toBeNull();
    expect(stub.calls.every((call) => call.key?.scope === 'PLATFORM')).toBe(true);
    expect(stub.calls.every((call) => call.key?.organizationKey === '')).toBe(true);
  });

  it('refuses a subtree caller asking for the platform chain, and reads nothing', async () => {
    // Platform-scoped rows are the ones with no tenant. ADR-053 § 10 reserves
    // them to SYSTEM_ADMIN, and a refusal must cost zero queries.
    const stub = stubRepository({ chains: unionChain });

    const code = await codeOf(() =>
      as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
        serviceFor(stub).verify(query({ scope: 'PLATFORM' })),
      ),
    );

    expect(code).toBe('FORBIDDEN');
    expect(stub.calls).toHaveLength(0);
  });

  it('makes a SYSTEM_ADMIN name the tenant, because no chain spans tenants', async () => {
    const stub = stubRepository({ chains: unionChain });

    const code = await codeOf(() =>
      as({ roles: ['SYSTEM_ADMIN'] }, () => serviceFor(stub).verify(query())),
    );

    expect(code).toBe('VALIDATION_FAILED');
    expect(stub.calls).toHaveLength(0);
  });

  it('verifies exactly the tenant a SYSTEM_ADMIN names, consulting no projection', async () => {
    const stub = stubRepository({ chains: unionChain, descendants: [] });

    const result = await as({ roles: ['SYSTEM_ADMIN'] }, () =>
      serviceFor(stub).verify(query({ organizationId: UNION })),
    );

    expect(result.organizationId).toBe(UNION);
    expect(stub.subtreeCalls).toHaveLength(0);
  });

  it('defaults a subtree caller to its own organization', async () => {
    const stub = stubRepository({ chains: unionChain });

    const result = await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
      serviceFor(stub).verify(query()),
    );

    expect(result.organizationId).toBe(UNION);
    expect(stub.subtreeCalls).toHaveLength(0);
  });

  it('lets a subtree caller verify a proved descendant', async () => {
    const stub = stubRepository({
      chains: {
        [`ORGANIZATION|${CHILD}|2026-08-01`]: buildChain({
          organizationId: CHILD,
          month: AUGUST,
          records: days(2),
        }),
      },
      descendants: [CHILD],
    });

    const result = await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
      serviceFor(stub).verify(query({ organizationId: CHILD })),
    );

    expect(result.organizationId).toBe(CHILD);
    expect(result.status).toBe('VALID');
    expect(stub.subtreeCalls).toEqual([[UNION, CHILD]]);
  });

  it('refuses a sibling before it reads a chain', async () => {
    const stub = stubRepository({ chains: unionChain, descendants: [CHILD] });

    const code = await codeOf(() =>
      as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
        serviceFor(stub).verify(query({ organizationId: SIBLING })),
      ),
    );

    expect(code).toBe('FORBIDDEN');
    expect(stub.calls).toHaveLength(0);
  });

  it('refuses the oversight role outright', async () => {
    // Despite the name, AUDITOR has no access to audit records at all.
    const stub = stubRepository({ chains: unionChain });

    const code = await codeOf(() =>
      as({ roles: ['AUDITOR', 'UNION_ADMIN'], organizationId: UNION }, () =>
        serviceFor(stub).verify(query()),
      ),
    );

    expect(code).toBe('FORBIDDEN');
    expect(stub.calls).toHaveLength(0);
  });

  it('refuses a service token', async () => {
    const stub = stubRepository({ chains: unionChain });

    const code = await codeOf(() =>
      as({ authType: 'SERVICE', roles: ['SYSTEM_ADMIN'] }, () => serviceFor(stub).verify(query())),
    );

    expect(code).toBe('FORBIDDEN');
    expect(stub.calls).toHaveLength(0);
  });

  it('refuses a role the matrix does not list', async () => {
    const stub = stubRepository({ chains: unionChain });

    const code = await codeOf(() =>
      as({ roles: ['ORGANIZATION_ADMIN'], organizationId: UNION }, () =>
        serviceFor(stub).verify(query()),
      ),
    );

    expect(code).toBe('FORBIDDEN');
    expect(stub.calls).toHaveLength(0);
  });
});

describe('what a verification writes down', () => {
  const clean = {
    [`ORGANIZATION|${UNION}|2026-08-01`]: buildChain({
      organizationId: UNION,
      month: AUGUST,
      records: days(3),
    }),
  };

  it('moves the failure counter for a divergence and for nothing else', async () => {
    // Every increment of this counter is a security incident (ADR-053 § 13). A
    // counter that also moved for an empty or legacy window would make the one
    // alert that must never be ignored the one that always fires.
    const legacy = buildChain({
      organizationId: UNION,
      month: AUGUST,
      records: [{ day: 1, legacy: true }, { day: 2 }],
    });

    const cleanStub = stubRepository({ chains: clean });
    await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
      serviceFor(cleanStub).verify(query()),
    );

    const emptyStub = stubRepository({ chains: {} });
    await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
      serviceFor(emptyStub).verify(query()),
    );

    const legacyStub = stubRepository({
      chains: { [`ORGANIZATION|${UNION}|2026-08-01`]: legacy },
    });
    await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
      serviceFor(legacyStub).verify(query()),
    );

    expect(await counterValue(auditChainVerificationFailuresTotal, {})).toBe(0);

    const damaged = buildChain({ organizationId: UNION, month: AUGUST, records: days(3) });
    const target = damaged.rows[1];
    if (target !== undefined) damaged.rows[1] = { ...target, actorId: 'USR-OTHER' };

    await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
      serviceFor(
        stubRepository({ chains: { [`ORGANIZATION|${UNION}|2026-08-01`]: damaged } }),
      ).verify(query()),
    );

    expect(
      await counterValue(auditChainVerificationFailuresTotal, {
        reason: 'RECORD_HASH_MISMATCH',
        scope: 'organization',
      }),
    ).toBe(1);
  });

  it('counts the verdict under a closed scope and outcome label', async () => {
    const stub = stubRepository({ chains: clean });
    await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
      serviceFor(stub).verify(query()),
    );

    expect(
      await counterValue(auditChainVerificationsTotal, { scope: 'organization', outcome: 'valid' }),
    ).toBe(1);
  });

  it('never names an organization in a metric label', async () => {
    const stub = stubRepository({ chains: clean });
    await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
      serviceFor(stub).verify(query()),
    );

    const metric = await auditChainVerificationsTotal.get();
    const labels = metric.values.flatMap((value) => Object.values(value.labels));
    expect(labels).not.toContain(UNION);
  });

  it('logs shape, counts and outcome — and nothing identifying', async () => {
    // A log aggregator has none of the audit store's access controls, so
    // "whose evidence looks altered" written into one is a disclosure the
    // store's own authorization was built to prevent (AGENTS.md S-09).
    const damaged = buildChain({ organizationId: UNION, month: AUGUST, records: days(3) });
    const target = damaged.rows[1];
    if (target !== undefined) damaged.rows[1] = { ...target, resourceId: 'AST-OTHER' };

    const stub = stubRepository({ chains: { [`ORGANIZATION|${UNION}|2026-08-01`]: damaged } });
    const result = await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
      serviceFor(stub).verify(query()),
    );

    const logged = logLines.join('\n');
    expect(logged).toContain('outcome=divergent');
    expect(logged).not.toContain(UNION);
    expect(logged).not.toContain(result.firstDivergence?.auditEventId ?? 'never-matches');
    expect(logged).not.toContain('AST-OTHER');
    expect(logged).not.toContain('corr-1');
  });

  it('writes one line per verification, whatever the verdict', async () => {
    const stub = stubRepository({ chains: clean });
    await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
      serviceFor(stub).verify(query()),
    );

    expect(logLines).toHaveLength(1);
    expect(logLines[0]).toContain('verified=3');
  });

  it('writes nothing at all for a refused request', async () => {
    const stub = stubRepository({ chains: clean });

    await codeOf(() => as({ roles: ['AUDITOR'] }, () => serviceFor(stub).verify(query())));

    expect(logLines).toHaveLength(0);
  });
});
