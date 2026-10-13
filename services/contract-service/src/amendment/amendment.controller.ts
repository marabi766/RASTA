import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePlatformUserId, zodPipe } from '@rasta/nest-common';
import type { CursorPage } from '../contract/dto';
import { IdempotencyStore, requiredIdempotencyKey } from '../shared/idempotency';
import { AmendmentService } from './amendment.service';
import {
  listAmendmentsQuerySchema,
  proposeAmendmentSchema,
  signAmendmentSchema,
  type AmendmentView,
  type ListAmendmentsQuery,
  type ProposeAmendmentDto,
  type SignAmendmentDto,
} from './dto';

/** The route templates the idempotency store keys on: a closed set, never an id. */
export const PROPOSE_AMENDMENT_ENDPOINT = 'POST /v1/contracts/{id}/amendments';
export const SIGN_AMENDMENT_ENDPOINT = 'POST /v1/contracts/{id}/amendments/{amendmentId}/sign';

const PARTIES_NOTE =
  'Closed by default (S-02). Read by the same two parties as the contract: the employer’s ' +
  'organization — the roles of CONTRACT_READER_ROLES, and SYSTEM_ADMIN acting for an organization ' +
  'it selected with X-Organization-Id — and the winning contractor’s organization (the CONTRACTOR ' +
  'role, in its own organization). Any other organization, a contract or amendment that does not ' +
  'exist and one of someone else are all 404, never 403 (S-03). AUDITOR and a service token are refused.';

const COMMAND_NOTE =
  'Requires an `Idempotency-Key` (docs/06 § 6.8): without one, or with one outside 8 to 255 ' +
  'characters, 400 VALIDATION_FAILED and nothing is done. The same key with the same body from ' +
  'the same user answers the original response and does nothing again; the same key with ' +
  'another body or user is 409 IDEMPOTENCY_KEY_REUSED; a duplicate that arrives while the first ' +
  'is still being processed waits for its answer and past a few seconds is 409 CONFLICT with ' +
  'Retry-After. The caller must be a signed-in person with a platform user id (403 otherwise); ' +
  'the platform administrator, the oversight role and a service token are refused. A contract ' +
  'of another organization, or one that does not exist, is 404 — never 403. A refusal of a party ' +
  'for want of authority is recorded (CONTRACT_AUTHORITY_REFUSED); when that record cannot be ' +
  'written the answer is 503 and nothing was done. Refusals carry their closed reason in ' +
  '`details[].code` (docs/06 § 6.7).';

/**
 * The amendment API of a contract (ADR-068 § 9, CON-003 PR 3). HTTP ↔ DTO and nothing else
 * (AGENTS.md A-10); no handler names a role — who proposes is configuration, who signs for the
 * employer is the `contract.signature` policy in force.
 */
@ApiTags('amendments')
@Controller({ path: 'contracts/:id/amendments', version: '1' })
export class AmendmentController {
  constructor(
    private readonly amendments: AmendmentService,
    private readonly idempotency: IdempotencyStore,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List the amendments of a contract, oldest first',
    description:
      'Every amendment of the contract, proposed or effective, with its amount in minor units as ' +
      `a decimal string and when each side signed it (never by whom). ${PARTIES_NOTE}`,
  })
  async list(
    @Param('id') id: string,
    @Query(zodPipe(listAmendmentsQuerySchema)) query: ListAmendmentsQuery,
  ): Promise<CursorPage<AmendmentView>> {
    return this.amendments.list(id, query);
  }

  @Get(':amendmentId')
  @ApiOperation({
    summary: 'Read one amendment',
    description: `One amendment of the contract. ${PARTIES_NOTE}`,
  })
  async get(
    @Param('id') id: string,
    @Param('amendmentId') amendmentId: string,
  ): Promise<AmendmentView> {
    return this.amendments.get(id, amendmentId);
  }

  @RequirePlatformUserId()
  @Post()
  @HttpCode(201)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 255 characters. Scoped to the organization.',
  })
  @ApiOperation({
    summary: 'Propose an amendment of a signed contract, employer only',
    description:
      'The employer proposes a change to the price of a SIGNED contract (422 `CONTRACT_NOT_SIGNED` ' +
      'otherwise): `deltaMinor` (a decimal string of minor units; it must be positive — a zero or ' +
      'negative change is 422 `AMENDMENT_DELTA_NOT_POSITIVE`, no document allows a reduction yet, ' +
      'Q-100), a `reasonCode` from the closed list CONTRACT_AMENDMENT_REASON_CODES names (422 ' +
      '`AMENDMENT_REASON_NOT_ALLOWED` otherwise) and a `reasonText`. It takes effect only when ' +
      'both parties have signed it (…/sign), and adds nothing to the price before. A price that ' +
      'with its amendments would pass the largest bigint is 422 `AMENDMENT_EXCEEDS_LIMIT`. Only ' +
      'the employer, with a role CONTRACT_AMENDMENT_ROLES names (default ORGANIZATION_ADMIN); the ' +
      'contractor is 403 `PROPOSER_NOT_EMPLOYER`. CONTRACT_AMENDMENT_PROPOSED carries the code, ' +
      `never the amount or the text. ${COMMAND_NOTE}`,
  })
  async propose(
    @Param('id') id: string,
    @Body(zodPipe(proposeAmendmentSchema)) dto: ProposeAmendmentDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<AmendmentView> {
    const key = requiredIdempotencyKey(idempotencyKey);
    const { result } = await this.idempotency.execute<AmendmentView>(
      PROPOSE_AMENDMENT_ENDPOINT,
      key,
      { id, ...dto },
      201,
      (fence) => this.amendments.propose(id, dto, fence),
      (stored) => this.amendments.assertContractVisible(stored.contractId),
    );
    return result;
  }

  @RequirePlatformUserId()
  @Post(':amendmentId/sign')
  @HttpCode(200)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      '8 to 255 characters. Scoped to the organization: the same key in two organizations is ' +
      'two requests — which matters here, because the two parties are two organizations.',
  })
  @ApiOperation({
    summary: 'Sign an amendment for the side the caller acts for (PROPOSED → EFFECTIVE)',
    description:
      'Each party signs separately, and the amendment becomes EFFECTIVE only when both have: the ' +
      'second signature, in the same transaction and under the contract’s lock, makes it ' +
      'effective, adds its amount to the contract’s amendments total and publishes CONTRACT_AMENDED ' +
      '(no amount); every signature is an audit record (CONTRACT_AMENDMENT_SIGNATURE_RECORDED). ' +
      'The same machinery as signing the contract: the employer’s side is signed by the roles the ' +
      '`contract.signature` approval policy in force for its organization names (with none in force, ' +
      '422 `SIGNATURE_POLICY_REQUIRED`; a policy whose union no longer governs the employer is 403 ' +
      '`POLICY_AUTHOR_NOT_GOVERNING`), the contractor’s by the CONTRACTOR role of its own ' +
      'organization. One person cannot sign for both sides (403 `MEMBER_OF_BOTH_PARTIES`, 403 ' +
      '`SAME_PERSON_BOTH_SIDES`; identities that cannot be told apart are 422 ' +
      '`ACTOR_IDENTITY_UNKNOWN`). The same person signing the same side again changes nothing; ' +
      'another person for a side that has signed is 409 `SIDE_ALREADY_SIGNED`; an amendment that is ' +
      'no longer proposed is 422 `AMENDMENT_NOT_PROPOSED`, a contract that is not signed 422 ' +
      '`CONTRACT_NOT_SIGNED`. `expectedVersion` is optional. ' +
      COMMAND_NOTE,
  })
  async sign(
    @Param('id') id: string,
    @Param('amendmentId') amendmentId: string,
    @Body(zodPipe(signAmendmentSchema)) dto: SignAmendmentDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<AmendmentView> {
    const key = requiredIdempotencyKey(idempotencyKey);
    // A replay answers the recorded outcome, but the body is the amendment as it is now, re-read
    // and scoped to the caller as a fresh GET would: the stored one is a snapshot (the other side
    // may have signed since), and the same read is the check the caller may still see it.
    let current: AmendmentView | undefined;
    const { result } = await this.idempotency.execute<AmendmentView>(
      SIGN_AMENDMENT_ENDPOINT,
      key,
      { id, amendmentId, ...dto },
      200,
      (fence) => this.amendments.sign(id, amendmentId, dto, fence),
      async (stored) => {
        current = await this.amendments.get(stored.contractId, stored.id);
      },
    );
    return current ?? result;
  }
}
