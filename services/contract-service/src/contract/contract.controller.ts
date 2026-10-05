import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { zodPipe } from '@rasta/nest-common';
import { ContractService } from './contract.service';
import { listContractsQuerySchema, type ListContractsQuery } from './dto';

const PARTIES_NOTE =
  'Closed by default (S-02). Read by the employer’s organization — the roles of ' +
  'CONTRACT_READER_ROLES (default ORGANIZATION_ADMIN), and SYSTEM_ADMIN acting for an ' +
  'organization it selected with X-Organization-Id — and by the winning contractor’s ' +
  'organization (the CONTRACTOR role, in its own organization). Any other organization, ' +
  'a contract that does not exist and a contract of someone else are all 404, never 403 ' +
  '(S-03). AUDITOR and a service token are refused. Contracts are created by the system ' +
  'when a tender is awarded; there is no route that writes one (ADR-068).';

/**
 * The contract read API. HTTP ↔ DTO and nothing else (AGENTS.md A-10).
 *
 * No handler names a role: who may read is configuration (`ContractAccess`), and a
 * decorator would be fixed at compile time. The global guards still demand a token on
 * every route.
 */
@ApiTags('contracts')
@Controller({ path: 'contracts', version: '1' })
export class ContractController {
  constructor(private readonly contracts: ContractService) {}

  @Get()
  @ApiOperation({
    summary: 'List the contracts the caller is a party to, newest first',
    description:
      'As the employer: the contracts of the organization the request acts for. As the ' +
      `winning contractor: the contracts awarded to it. ${PARTIES_NOTE}`,
  })
  async list(@Query(zodPipe(listContractsQuerySchema)) query: ListContractsQuery) {
    return this.contracts.list(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Read one contract',
    description:
      'The contract, with its amount in minor units as a decimal string. The amount is the ' +
      'winning bid’s price as construction-service states it; it is never on an event. ' +
      PARTIES_NOTE,
  })
  async get(@Param('id') id: string) {
    return this.contracts.get(id);
  }
}
