import { isRastaError } from '@rasta/nest-common';
import { resolveSubtreeTarget, type SubtreeOracle } from './audit.scope';
import type { AuditCallerAuthority } from '../access/access';
import { auditSubtreeDecisionsTotal, SUBTREE_DECISIONS } from '../observability/metrics';

/**
 * The subtree rule, asserted in the one place both endpoints now read it from.
 *
 * It was extracted from `AuditQueryService` when AUD-003 added a second caller,
 * and the extraction is only worth anything if the rule is tested here rather
 * than only through whichever endpoint happens to call it. The property that
 * matters is direction: the projection may **extend** a caller's authority and
 * may never establish it, so a projection that is empty, stale or wrong costs a
 * union administrator a result they were entitled to and never grants one they
 * were not.
 */

const UNION = 'ORG-UNION';
const CHILD = 'ORG-CHILD';
const SIBLING = 'ORG-SIBLING';

const subtree: AuditCallerAuthority = { kind: 'SUBTREE', rootOrganizationId: UNION };

function oracle(descendants: string[]): { oracle: SubtreeOracle; calls: [string, string][] } {
  const calls: [string, string][] = [];
  return {
    calls,
    oracle: {
      isWithinProjectedSubtree: async (root: string, target: string): Promise<boolean> => {
        calls.push([root, target]);
        return descendants.includes(target);
      },
    },
  };
}

/** The counter's value for one decision label, or zero if never incremented. */
async function decisionCount(decision: string): Promise<number> {
  const metric = await auditSubtreeDecisionsTotal.get();
  return metric.values.find((value) => value.labels.decision === decision)?.value ?? 0;
}

beforeEach(() => {
  auditSubtreeDecisionsTotal.reset();
});

describe('a subtree caller that names no organization', () => {
  it('resolves to its own organization, exactly', async () => {
    // Not the subtree. The token names one organization, and a silent default
    // that widened to everything beneath it would turn a convenience into a
    // disclosure the caller never asked for.
    const { oracle: stub, calls } = oracle([CHILD]);

    await expect(resolveSubtreeTarget(stub, subtree, undefined)).resolves.toBe(UNION);
    expect(calls).toHaveLength(0);
  });

  it('does not consult the projection to reach its own organization', async () => {
    // Authority over your own organization comes from the verified token. A
    // projection lookup here would make a caller's own evidence unreadable
    // whenever the replica lagged.
    const { oracle: stub, calls } = oracle([]);

    await expect(resolveSubtreeTarget(stub, subtree, UNION)).resolves.toBe(UNION);
    expect(calls).toHaveLength(0);
  });
});

describe('a subtree caller that names another organization', () => {
  it('allows one the projection proves is beneath it', async () => {
    const { oracle: stub, calls } = oracle([CHILD]);

    await expect(resolveSubtreeTarget(stub, subtree, CHILD)).resolves.toBe(CHILD);
    expect(calls).toEqual([[UNION, CHILD]]);
  });

  it('refuses a sibling', async () => {
    const { oracle: stub } = oracle([CHILD]);

    await expect(resolveSubtreeTarget(stub, subtree, SIBLING)).rejects.toThrow();
  });

  it('refuses an organization it holds no projection for', async () => {
    // Fail closed: an empty projection is "cannot prove", never "assume yes".
    const { oracle: stub } = oracle([]);

    await expect(resolveSubtreeTarget(stub, subtree, CHILD)).rejects.toThrow();
  });

  it('refuses with FORBIDDEN and the same message for every kind of stranger', async () => {
    // One message, whether the organization is a sibling, a stranger, one that
    // has moved out or one nothing is projected for. Telling them apart would
    // let a caller map the hierarchy by probing identifiers.
    const { oracle: stub } = oracle([]);

    const messages: string[] = [];
    let code = '';
    for (const target of [SIBLING, 'ORG-UNKNOWN', 'ORG-MOVED-OUT']) {
      try {
        await resolveSubtreeTarget(stub, subtree, target);
      } catch (error) {
        if (isRastaError(error)) {
          code = error.code;
          messages.push(error.message);
        }
      }
    }

    expect(code).toBe('FORBIDDEN');
    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).not.toContain(SIBLING);
  });
});

describe('what the decision counter records', () => {
  it('counts an own-organization decision', async () => {
    const { oracle: stub } = oracle([]);
    await resolveSubtreeTarget(stub, subtree, UNION);

    expect(await decisionCount(SUBTREE_DECISIONS.OWN_ORGANIZATION)).toBe(1);
  });

  it('counts a proved descendant', async () => {
    const { oracle: stub } = oracle([CHILD]);
    await resolveSubtreeTarget(stub, subtree, CHILD);

    expect(await decisionCount(SUBTREE_DECISIONS.DESCENDANT)).toBe(1);
  });

  it('collapses every refusal into one bucket, naming nobody', async () => {
    const { oracle: stub } = oracle([]);
    for (const target of [SIBLING, 'ORG-UNKNOWN']) {
      await resolveSubtreeTarget(stub, subtree, target).catch(() => undefined);
    }

    expect(await decisionCount(SUBTREE_DECISIONS.REFUSED)).toBe(2);

    // The label set stays three values wide no matter what was refused: the
    // organization identifier never reaches the metric (ADR-053 § 13).
    const metric = await auditSubtreeDecisionsTotal.get();
    const labels = new Set(metric.values.map((value) => String(value.labels.decision)));
    const allowed = Object.values(SUBTREE_DECISIONS) as string[];
    expect([...labels].every((label) => allowed.includes(label))).toBe(true);
  });
});
