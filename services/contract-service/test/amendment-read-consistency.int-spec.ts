import { AmendmentRepository } from '../src/amendment/amendment.repository';
import { startApi, type ApiHarness } from './api-helpers';
import { http, propose, seedSigned, signAmendment } from './amendment-helpers';
import { cleanup, wire, type Wiring } from './helpers';

/**
 * #235 review round 1: an amendment and its signatures are read from ONE snapshot. Read apart, a
 * second signature committing between the two reads showed a PROPOSED amendment with both
 * signatures. The race is made deterministic: right after the amendment row is read, the other
 * side signs (and the amendment becomes EFFECTIVE) on another connection — the reader's view must
 * stay the one it began with, never a mixture.
 */
describe('reading an amendment and its signatures is one snapshot (#235 round 1)', () => {
  let api: ApiHarness;
  let w: Wiring;
  let repository: AmendmentRepository;
  const organizations: string[] = [];

  beforeAll(async () => {
    api = await startApi();
    w = wire();
    repository = api.app.get(AmendmentRepository);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await cleanup(organizations);
    await w.close();
    await api.close();
  });

  /** A signed contract with an amendment the employer has signed and the contractor has not. */
  async function halfSigned() {
    const contract = await seedSigned(api, w, organizations);
    const amendment = (await propose(api, contract.id, contract.employerToken).expect(201)).body;
    await signAmendment(api, contract.id, amendment.id, contract.employerToken).expect(200);
    return { contract, amendmentId: amendment.id as string };
  }

  /** Makes the next call of `method` sign the amendment for the contractor right after it read. */
  function contractorSignsAfter(
    method: 'findOne' | 'list',
    contract: Awaited<ReturnType<typeof seedSigned>>,
    amendmentId: string,
  ): jest.SpyInstance {
    const original = repository[method].bind(repository) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    let done = false;
    return jest.spyOn(repository, method).mockImplementation((async (...args: unknown[]) => {
      const rows = await original(...args);
      if (!done) {
        done = true;
        await signAmendment(api, contract.id, amendmentId, contract.contractorToken).expect(200);
      }
      return rows;
    }) as never);
  }

  it('one amendment: the other side signing between the reads does not show a PROPOSED amendment with both signatures', async () => {
    const { contract, amendmentId } = await halfSigned();
    const spy = contractorSignsAfter('findOne', contract, amendmentId);

    const seen = await http(api)
      .get(`/v1/contracts/${contract.id}/amendments/${amendmentId}`)
      .set('authorization', `Bearer ${contract.employerToken}`)
      .expect(200);
    spy.mockRestore();

    expect(seen.body).toMatchObject({ status: 'PROPOSED', contractorSignedAt: null });
    expect(seen.body.employerSignedAt).not.toBeNull();

    // The next read sees the committed state, whole.
    const after = await http(api)
      .get(`/v1/contracts/${contract.id}/amendments/${amendmentId}`)
      .set('authorization', `Bearer ${contract.employerToken}`)
      .expect(200);
    expect(after.body).toMatchObject({ status: 'EFFECTIVE' });
    expect(after.body.contractorSignedAt).not.toBeNull();
  });

  it('the list: the same, for every row of the page', async () => {
    const { contract, amendmentId } = await halfSigned();
    const spy = contractorSignsAfter('list', contract, amendmentId);

    const seen = await http(api)
      .get(`/v1/contracts/${contract.id}/amendments`)
      .set('authorization', `Bearer ${contract.employerToken}`)
      .expect(200);
    spy.mockRestore();

    expect(seen.body.items).toHaveLength(1);
    expect(seen.body.items[0]).toMatchObject({ status: 'PROPOSED', contractorSignedAt: null });

    const after = await http(api)
      .get(`/v1/contracts/${contract.id}/amendments`)
      .set('authorization', `Bearer ${contract.employerToken}`)
      .expect(200);
    expect(after.body.items[0]).toMatchObject({ status: 'EFFECTIVE' });
  });
});
