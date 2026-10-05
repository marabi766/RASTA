import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePlatformUserId, zodPipe } from '@rasta/nest-common';
import { IdempotencyStore, requiredIdempotencyKey } from '../shared/idempotency';
import { ContractService } from './contract.service';
import {
  cancelContractSchema,
  listContractsQuerySchema,
  signContractSchema,
  type CancelContractDto,
  type ContractView,
  type ListContractsQuery,
  type SignContractDto,
} from './dto';

/** The route templates the idempotency store keys on: a closed set, never an id. */
export const SIGN_CONTRACT_ENDPOINT = 'POST /v1/contracts/{id}/sign';
export const CANCEL_CONTRACT_ENDPOINT = 'POST /v1/contracts/{id}/cancel';

const PARTIES_NOTE =
  'Closed by default (S-02). Read by the employer’s organization — the roles of ' +
  'CONTRACT_READER_ROLES (default ORGANIZATION_ADMIN), and SYSTEM_ADMIN acting for an ' +
  'organization it selected with X-Organization-Id — and by the winning contractor’s ' +
  'organization (the CONTRACTOR role, in its own organization). Any other organization, ' +
  'a contract that does not exist and a contract of someone else are all 404, never 403 ' +
  '(S-03). AUDITOR and a service token are refused. Contracts are created by the system ' +
  'when a tender is awarded; there is no route that creates one (ADR-068).';

const COMMAND_NOTE =
  'Requires an `Idempotency-Key` (docs/06 § 6.8): without one, or with one outside 8 to 255 ' +
  'characters, 400 VALIDATION_FAILED and nothing is done. The same key with the same body from ' +
  'the same user answers the original response and does nothing again; the same key with ' +
  'another body or user is 409 IDEMPOTENCY_KEY_REUSED; a duplicate that arrives while the first ' +
  'is still being processed waits for its answer and past a few seconds is 409 CONFLICT with ' +
  'Retry-After. The caller must be a signed-in person with a platform user id (403 otherwise); ' +
  'the platform administrator, the oversight role and a service token are refused. A contract ' +
  'of another organization, or one that does not exist, is 404 — never 403 — and nothing is ' +
  'said of which roles the caller lacked. Refusals carry their closed reason in ' +
  '`details[].code` (docs/06 § 6.7).';

/**
 * The contract API. HTTP ↔ DTO and nothing else (AGENTS.md A-10).
 *
 * No handler names a role: who may read, sign or cancel is configuration (`ContractAccess`), and
 * a decorator would be fixed at compile time. The global guards still demand a token on every
 * route.
 */
@ApiTags('contracts')
@Controller({ path: 'contracts', version: '1' })
export class ContractController {
  constructor(
    private readonly contracts: ContractService,
    private readonly idempotency: IdempotencyStore,
  ) {}

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
      'The contract, with its amount in minor units as a decimal string, when each side ' +
      'accepted it (never by whom) and, once cancelled, why. The amount is the winning bid’s ' +
      'price as construction-service states it; it is never on an event. ' +
      PARTIES_NOTE,
  })
  async get(@Param('id') id: string) {
    return this.contracts.get(id);
  }

  // The command records who signed and compares the two signers on their stable identity (#188):
  // a user token without the platform user id is refused (403) before anything is done.
  @RequirePlatformUserId()
  @Post(':id/sign')
  @HttpCode(200)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      '8 to 255 characters. Scoped to the organization: the same key in two organizations is ' +
      'two requests — which matters here, because the two parties are two organizations.',
  })
  @ApiOperation({
    summary: 'Accept the draft contract for the side the caller acts for (DRAFT → SIGNED)',
    description:
      'Each party accepts separately, and the contract becomes SIGNED only when both have: ' +
      'the second acceptance, in the same transaction, moves the contract (compare-and-set on ' +
      'its version) and publishes CONTRACT_SIGNED; every acceptance is an audit record ' +
      '(CONTRACT_SIGNATURE_RECORDED). It is a recorded acceptance of both parties — not a legal ' +
      'signature (Q-95 (1)). The employer’s side is signed by the roles the ' +
      '`contract.signature` approval policy in force for its organization names ' +
      '(/v1/approval-policies; the signature records the policy’s id and version): with none ' +
      'in force nobody signs for the employer, 422 `SIGNATURE_POLICY_REQUIRED`. The contractor’s side is signed by the CONTRACTOR role ' +
      'of its own organization. One person cannot sign for both sides — a caller who is a member ' +
      'of both organizations is refused (403 `MEMBER_OF_BOTH_PARTIES`) and so is one who already ' +
      'signed the other side (403 `SAME_PERSON_BOTH_SIDES`); two signers whose identities cannot ' +
      'be told apart are 422 `ACTOR_IDENTITY_UNKNOWN`. The same person signing the same side ' +
      'again changes nothing and answers with the contract as it is; another person for a side ' +
      'that has signed is 409 `SIDE_ALREADY_SIGNED`; a contract that is not a draft is 422 ' +
      '`CONTRACT_NOT_DRAFT`. `expectedVersion` is optional. ' +
      COMMAND_NOTE,
  })
  async sign(
    @Param('id') id: string,
    @Body(zodPipe(signContractSchema)) dto: SignContractDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<ContractView> {
    const key = requiredIdempotencyKey(idempotencyKey);
    const { result } = await this.idempotency.execute<ContractView>(
      SIGN_CONTRACT_ENDPOINT,
      key,
      { id, ...dto },
      200,
      (fence) => this.contracts.sign(id, dto, fence),
      // The caller may have stopped being a party since.
      (stored) => this.contracts.assertVisible(stored.id),
    );
    return result;
  }

  @RequirePlatformUserId()
  @Post(':id/cancel')
  @HttpCode(200)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 255 characters. Scoped to the organization.',
  })
  @ApiOperation({
    summary: 'Cancel a draft contract (DRAFT → CANCELLED), employer only',
    description:
      'The employer ends a draft, for a `reasonCode` from the closed list ' +
      'CONTRACT_CANCEL_REASON_CODES names (422 `CANCEL_REASON_NOT_ALLOWED` otherwise) and an ' +
      'optional bounded note without bidirectional control characters; CONTRACT_CANCELLED carries ' +
      'the code, never the note. The roles are CONTRACT_CANCEL_ROLES (default ' +
      'ORGANIZATION_ADMIN); the contractor is told 403. Only a draft is cancelled — a SIGNED ' +
      'contract is ended by no route (422 `CONTRACT_NOT_DRAFT`; termination is a legal decision ' +
      'the platform does not make, Q-95 (4)) — and, by default, not a draft one side has already ' +
      'signed (422 `SIGNATURE_RECORDED`, unless CONTRACT_CANCEL_AFTER_SIGNATURE is set). ' +
      '`expectedVersion` is optional. ' +
      COMMAND_NOTE,
  })
  async cancel(
    @Param('id') id: string,
    @Body(zodPipe(cancelContractSchema)) dto: CancelContractDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<ContractView> {
    const key = requiredIdempotencyKey(idempotencyKey);
    const { result } = await this.idempotency.execute<ContractView>(
      CANCEL_CONTRACT_ENDPOINT,
      key,
      { id, ...dto },
      200,
      (fence) => this.contracts.cancel(id, dto, fence),
      (stored) => this.contracts.assertVisible(stored.id),
    );
    return result;
  }
}
