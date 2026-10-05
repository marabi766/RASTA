import { Injectable } from '@nestjs/common';
import { RastaError } from '@rasta/nest-common';
import type { Contract } from '../generated/prisma';
import { ContractAccess, assertPartyOf } from '../access/access';
import { ContractRepository } from './contract.repository';
import type { ContractView, CursorPage, ListContractsQuery } from './dto';
import { toContractView } from './views';

/**
 * Reads of a contract (ADR-068 § 7). A contract is made by the consumer of
 * `TENDER_AWARDED` and by nothing else, so this service has no command a user can give;
 * it answers the two parties — the employer, and the winning contractor — and nobody else.
 *
 * Business rules live here, not in the controller (AGENTS.md A-10).
 */
@Injectable()
export class ContractService {
  constructor(
    private readonly repository: ContractRepository,
    private readonly access: ContractAccess,
  ) {}

  /**
   * One contract, to a party to it. Any other caller — an organization that is neither the
   * employer nor the winning contractor, and one that is missing — gets the same `404`.
   */
  async get(id: string): Promise<ContractView> {
    const parties = this.access.assertCanRead();

    let row: Contract | null = null;
    if (parties.employer) row = await this.repository.findOwn(id);
    if (!row && parties.contractor) {
      row = await this.repository.findAsContractor(parties.organizationId, id);
    }
    if (!row) throw RastaError.notFound('Contract', id);

    // The row-level half of the guard: whatever query produced the row, it is a party's.
    assertPartyOf(row, parties);
    return toContractView(row);
  }

  /** The caller's contracts, newest first: as employer, as winning contractor, or both. */
  async list(query: ListContractsQuery): Promise<CursorPage<ContractView>> {
    const parties = this.access.assertCanRead();
    const filter = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      limit: query.limit,
    };

    const found: Contract[] = [];
    if (parties.employer) found.push(...(await this.repository.listOwn(filter)));
    if (parties.contractor) {
      found.push(...(await this.repository.listAsContractor(parties.organizationId, filter)));
    }

    // Newest first across the two sides; one contract is never both (the employer is not its
    // own contractor — `ck_contract_parties_distinct`), so nothing is listed twice.
    found.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const hasMore = found.length > query.limit;
    const visible = hasMore ? found.slice(0, query.limit) : found;
    visible.forEach((row) => assertPartyOf(row, parties));

    return {
      items: visible.map(toContractView),
      nextCursor: hasMore ? (visible[visible.length - 1]?.id ?? null) : null,
      hasMore,
    };
  }
}
