import { SupplierController } from './supplier.controller';
import type { SupplierService } from './supplier.service';
import type { QualificationService } from './qualification.service';
import type { SuspensionService } from './suspension.service';

/**
 * The controller is HTTP ↔ DTO and nothing else (AGENTS.md A-10).
 *
 * So what is worth testing is not logic — there is none — but **wiring**:
 * that each route reaches the service method it claims to, with the path
 * parameters in the right order. Wiring `approve` to `reject`, or passing the
 * qualification id where the supplier id belongs, is a real defect that
 * typechecks perfectly: both parameters are strings.
 *
 * The tests below record what each handler forwarded and assert the exact call.
 */

type Call = { method: string; args: unknown[] };

function recorder(methods: string[], calls: Call[]) {
  const target: Record<string, unknown> = {};
  for (const method of methods) {
    target[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve({ recorded: method });
    };
  }
  return target;
}

function harness() {
  const calls: Call[] = [];

  const controller = new SupplierController(
    recorder(
      ['register', 'get', 'search', 'listQualifiedFor'],
      calls,
    ) as unknown as SupplierService,
    recorder(
      ['submit', 'approve', 'reject', 'reviewQueue'],
      calls,
    ) as unknown as QualificationService,
    recorder(['suspend', 'reinstate'], calls) as unknown as SuspensionService,
  );

  return { controller, calls };
}

describe('profile routes', () => {
  it('forwards registration with the body alone — the organization is the token', async () => {
    const { controller, calls } = harness();
    const dto = { displayName: 'A workshop', capabilities: ['WORKSHOP_SERVICE' as const] };

    await controller.register(dto);

    expect(calls).toEqual([{ method: 'register', args: [dto] }]);
  });

  it('forwards a read with the supplier id', async () => {
    const { controller, calls } = harness();

    await controller.get('SUP_1');

    expect(calls).toEqual([{ method: 'get', args: ['SUP_1'] }]);
  });
});

describe('directory routes', () => {
  it('forwards a search to the directory query', async () => {
    const { controller, calls } = harness();

    await controller.search({ limit: 25 });

    expect(calls).toEqual([{ method: 'search', args: [{ limit: 25 }] }]);
  });

  it('forwards ListQualifiedFor to its own query, not to search', async () => {
    // Two different queries with two different filters. Routing one to the
    // other would silently return suppliers who merely *claim* a capability.
    const { controller, calls } = harness();

    await controller.listQualifiedFor({ capability: 'WORKSHOP_SERVICE', limit: 25 });

    expect(calls).toEqual([
      { method: 'listQualifiedFor', args: [{ capability: 'WORKSHOP_SERVICE', limit: 25 }] },
    ]);
  });

  it('forwards the review queue to the qualification service', async () => {
    const { controller, calls } = harness();

    await controller.reviewQueue({ state: 'SUBMITTED', limit: 25 });

    expect(calls).toEqual([{ method: 'reviewQueue', args: [{ state: 'SUBMITTED', limit: 25 }] }]);
  });
});

describe('qualification routes', () => {
  it('forwards a submission with the supplier id first', async () => {
    const { controller, calls } = harness();
    const dto = { capability: 'WORKSHOP_SERVICE' as const, evidence: [] };

    await controller.submitQualification('SUP_1', dto);

    expect(calls).toEqual([{ method: 'submit', args: ['SUP_1', dto] }]);
  });

  it('forwards an approval with the supplier id, then the qualification id', async () => {
    // Both are strings, so swapping them typechecks. This is the assertion that
    // catches it.
    const { controller, calls } = harness();

    await controller.approveQualification('SUP_1', 'QLF_9', { note: 'Checked' });

    expect(calls).toEqual([{ method: 'approve', args: ['SUP_1', 'QLF_9', { note: 'Checked' }] }]);
  });

  it('forwards a rejection to reject, never to approve', async () => {
    const { controller, calls } = harness();
    const dto = { reason: 'The submission named no evidence' };

    await controller.rejectQualification('SUP_1', 'QLF_9', dto);

    expect(calls).toEqual([{ method: 'reject', args: ['SUP_1', 'QLF_9', dto] }]);
  });
});

describe('suspension routes', () => {
  it('forwards a suspension to suspend', async () => {
    const { controller, calls } = harness();
    const dto = { reason: 'Two undelivered orders in one week' };

    await controller.suspend('SUP_1', dto);

    expect(calls).toEqual([{ method: 'suspend', args: ['SUP_1', dto] }]);
  });

  it('forwards a reinstatement to reinstate, never to suspend', async () => {
    // The two are opposites and take an identically-shaped body.
    const { controller, calls } = harness();
    const dto = { reason: 'The orders were delivered late, not never' };

    await controller.reinstate('SUP_1', dto);

    expect(calls).toEqual([{ method: 'reinstate', args: ['SUP_1', dto] }]);
  });
});

describe('the controller holds no logic', () => {
  it('returns whatever the service returned, untouched', async () => {
    const { controller } = harness();

    expect(await controller.get('SUP_1')).toEqual({ recorded: 'get' });
    expect(await controller.search({ limit: 25 })).toEqual({ recorded: 'search' });
  });
});
