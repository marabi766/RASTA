import { ContractRepository } from '../src/contract/contract.repository';
import { startApi, person, type ApiHarness } from './api-helpers';
import { http, idemKey } from './amendment-helpers';
import { cleanup, seedDraft, wire, type Wiring } from './helpers';

/**
 * A contract and its signature facts are read from ONE snapshot (Codex on #241, pre-existing).
 * Read apart, a signature committing between the contract read and the signatures read showed the
 * old DRAFT status and version with both signature timestamps — a state that never existed. The
 * race is made deterministic: right after the contract row(s) are read, the other side signs (and
 * the contract becomes SIGNED) on another connection; the reader must keep the view it began with.
 */
describe('reading a contract and its signatures is one snapshot', () => {
  let api: ApiHarness;
  let w: Wiring;
  let repository: ContractRepository;
  const organizations: string[] = [];

  beforeAll(async () => {
    api = await startApi();
    w = wire();
    repository = api.app.get(ContractRepository);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await cleanup(organizations);
    await w.close();
    await api.close();
  });

  const signAs = (id: string, token: string) =>
    http(api)
      .post(`/v1/contracts/${id}/sign`)
      .set('authorization', `Bearer ${token}`)
      .set('idempotency-key', idemKey('snapshot-sign'))
      .send({});

  /** A draft the employer has signed and the contractor has not. */
  async function halfSigned() {
    const draft = await seedDraft(w, organizations);
    const employerToken = person(draft.employer, ['ORGANIZATION_ADMIN']);
    const contractorToken = person(draft.contractor, ['CONTRACTOR']);
    await signAs(draft.id, employerToken).expect(200);
    return { id: draft.id, employerToken, contractorToken };
  }

  /** Makes the next call of `method` have the contractor sign right after it read. */
  function contractorSignsAfter(
    method: 'findOwn' | 'listOwn' | 'findAsContractor' | 'listAsContractor',
    contract: Awaited<ReturnType<typeof halfSigned>>,
  ): jest.SpyInstance {
    const original = repository[method].bind(repository) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    let done = false;
    return jest.spyOn(repository, method).mockImplementation((async (...args: unknown[]) => {
      const rows = await original(...args);
      if (!done) {
        done = true;
        await signAs(contract.id, contract.contractorToken).expect(200);
      }
      return rows;
    }) as never);
  }

  /** Every state the contract was ever in is one of these: status, version and facts agree. */
  function expectConsistent(view: {
    status: string;
    version: number;
    employerSignedAt: string | null;
    contractorSignedAt: string | null;
  }) {
    const both = view.employerSignedAt !== null && view.contractorSignedAt !== null;
    expect(view.status === 'SIGNED').toBe(both);
  }

  it('get as the employer: the other side signing between the reads does not show a DRAFT with both signatures', async () => {
    const contract = await halfSigned();
    const before = await http(api)
      .get(`/v1/contracts/${contract.id}`)
      .set('authorization', `Bearer ${contract.employerToken}`)
      .expect(200);
    const spy = contractorSignsAfter('findOwn', contract);

    const seen = await http(api)
      .get(`/v1/contracts/${contract.id}`)
      .set('authorization', `Bearer ${contract.employerToken}`)
      .expect(200);
    spy.mockRestore();

    expectConsistent(seen.body);
    expect(seen.body).toMatchObject({
      status: 'DRAFT',
      version: before.body.version,
      contractorSignedAt: null,
    });
    expect(seen.body.employerSignedAt).not.toBeNull();

    // The next read sees the committed state, whole.
    const after = await http(api)
      .get(`/v1/contracts/${contract.id}`)
      .set('authorization', `Bearer ${contract.employerToken}`)
      .expect(200);
    expectConsistent(after.body);
    expect(after.body).toMatchObject({ status: 'SIGNED', version: before.body.version + 1 });
    expect(after.body.contractorSignedAt).not.toBeNull();
  });

  it('get as the contractor: the same', async () => {
    const contract = await halfSigned();
    const racer = contractorSignsAfter('findAsContractor', contract);

    const seen = await http(api)
      .get(`/v1/contracts/${contract.id}`)
      .set('authorization', `Bearer ${contract.contractorToken}`)
      .expect(200);
    racer.mockRestore();

    expectConsistent(seen.body);
    expect(seen.body).toMatchObject({ status: 'DRAFT', contractorSignedAt: null });
  });

  it('the list: the same, for every row of the page', async () => {
    const contract = await halfSigned();
    const spy = contractorSignsAfter('listOwn', contract);

    const seen = await http(api)
      .get('/v1/contracts')
      .query({ limit: 100 })
      .set('authorization', `Bearer ${contract.employerToken}`)
      .expect(200);
    spy.mockRestore();

    const row = seen.body.items.find((item: { id: string }) => item.id === contract.id);
    expect(row).toMatchObject({ status: 'DRAFT', contractorSignedAt: null });
    for (const item of seen.body.items) expectConsistent(item);

    const after = await http(api)
      .get('/v1/contracts')
      .query({ limit: 100 })
      .set('authorization', `Bearer ${contract.employerToken}`)
      .expect(200);
    expect(after.body.items.find((item: { id: string }) => item.id === contract.id)).toMatchObject({
      status: 'SIGNED',
    });
  });
});
