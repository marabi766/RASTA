import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles, zodPipe } from '@rasta/nest-common';
import { SupplierService } from './supplier.service';
import { QualificationService } from './qualification.service';
import { SuspensionService } from './suspension.service';
import {
  approveQualificationSchema,
  listQualifiedForQuerySchema,
  registerSupplierSchema,
  reinstateSupplierSchema,
  rejectQualificationSchema,
  reviewQueueQuerySchema,
  searchSuppliersQuerySchema,
  submitQualificationSchema,
  suspendSupplierSchema,
  type ApproveQualificationDto,
  type ListQualifiedForQuery,
  type RegisterSupplierDto,
  type ReinstateSupplierDto,
  type RejectQualificationDto,
  type ReviewQueueQuery,
  type SearchSuppliersQuery,
  type SubmitQualificationDto,
  type SuspendSupplierDto,
} from './dto';
import { DIRECTORY_ROLES, PLATFORM_ROLES, SUPPLIER_SIDE_ROLES } from '../access/access';

/**
 * The supplier HTTP surface (`docs/04` § 4.10, `docs/06`).
 *
 * HTTP ↔ DTO and nothing else (AGENTS.md A-10). Every decision — who may act,
 * which transitions are legal, what a projection contains — is made in the
 * services and in `access.ts`, and this file would be equally correct if it
 * were generated.
 *
 * ## Route ordering matters here
 *
 * `qualified` and `qualifications` are declared **before** `:id`. Nest matches
 * in declaration order, so a literal segment placed after the parameter would be
 * swallowed by it and `GET /v1/suppliers/qualified` would look up a supplier
 * whose id is the word "qualified". `openapi/document.spec.ts` asserts the
 * order rather than trusting it.
 *
 * ## What is not here
 *
 * `GET /v1/suppliers/{id}/performance` — named in `docs/04` § 4.10 and
 * deliberately absent. Q-12 has not defined a score, so the endpoint would have
 * to return either an invented number or a permanent placeholder. ADR-041 made
 * the same call for marketplace's qualification check and named the reason: a
 * check that does not exist must not look like one that passed.
 *
 * `AUDITOR` appears in no `@Roles` below. `docs/09` § 9.3 gives the oversight
 * role aggregate access only, and `access.ts` refuses it again on the row — the
 * three-layer defence economic-service, marketplace-service and
 * document-service each carry.
 */
@ApiTags('suppliers')
@Controller({ path: 'suppliers', version: '1' })
export class SupplierController {
  constructor(
    private readonly suppliers: SupplierService,
    private readonly qualifications: QualificationService,
    private readonly suspensions: SuspensionService,
  ) {}

  // -- profile --------------------------------------------------------------

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles(...SUPPLIER_SIDE_ROLES)
  @ApiOperation({
    summary: "Register the calling organization's supplier profile",
    description:
      'The organization is taken from the verified token; there is no field for it in the ' +
      'request body. Capabilities are claims, not qualifications — registering grants ' +
      'nothing, and a newly registered supplier is qualified for nothing until a platform ' +
      'operator explicitly approves a submission. A second registration for the same ' +
      'organization is refused with 409 rather than returning the existing profile.',
  })
  async register(@Body(zodPipe(registerSupplierSchema)) dto: RegisterSupplierDto) {
    return this.suppliers.register(dto);
  }

  // -- directory (declared before `:id`) ------------------------------------

  @Get()
  @Roles(...DIRECTORY_ROLES)
  @ApiOperation({
    summary: 'Search the public supplier directory',
    description:
      'Deliberately cross-tenant: an open, criteria-driven list is this service’s stated ' +
      'mission (docs/04 § 4.10). Responses carry catalogue-safe fields only — no evidence ' +
      'document identifiers, no decision notes, no actor identifiers and no suspension ' +
      'reasons. `qualifiedFor` returns only suppliers with a current approval, which ' +
      'excludes every suspended supplier. There is no free-text or rating sort: no search ' +
      'index is deployed for this service, and no performance score exists (Q-12).',
  })
  async search(@Query(zodPipe(searchSuppliersQuerySchema)) query: SearchSuppliersQuery) {
    return this.suppliers.search(query);
  }

  @Get('qualified')
  @Roles(...DIRECTORY_ROLES)
  @ApiOperation({
    summary: 'List suppliers currently qualified for one capability',
    description:
      'The query another service will eventually ask through a port — maintenance for a ' +
      'workshop referral, marketplace for a qualification check. "Currently" means an ' +
      'approved qualification on a supplier that is not suspended; the filter is applied in ' +
      'the query, so a suspended supplier is excluded before pagination rather than after. ' +
      'An approval records that a named operator approved a submission at a stated time. It ' +
      'does not assert that any evidence document was fetched, opened, scanned or found ' +
      'authentic, current or legally valid — this service does not read documents.',
  })
  async listQualifiedFor(
    @Query(zodPipe(listQualifiedForQuerySchema)) query: ListQualifiedForQuery,
  ) {
    return this.suppliers.listQualifiedFor(query);
  }

  @Get('qualifications')
  @Roles(...PLATFORM_ROLES)
  @ApiOperation({
    summary: 'The platform review queue',
    description:
      'Cross-tenant and restricted to SYSTEM_ADMIN and UNION_ADMIN, because it returns the ' +
      'private qualification record including evidence document identifiers. It exists so a ' +
      'reviewer can find submissions without already knowing which supplier applied.',
  })
  async reviewQueue(@Query(zodPipe(reviewQueueQuerySchema)) query: ReviewQueueQuery) {
    return this.qualifications.reviewQueue(query);
  }

  @Get(':id')
  @Roles(...DIRECTORY_ROLES)
  @ApiOperation({
    summary: 'Read one supplier’s private record',
    description:
      'The caller’s own organization, or a platform operator. A supplier owned by another ' +
      'organization answers 404 rather than 403, so its existence is never disclosed — the ' +
      'directory is where a stranger legitimately sees that a supplier exists, and it ' +
      'returns a different, catalogue-safe object.',
  })
  async get(@Param('id') id: string) {
    return this.suppliers.get(id);
  }

  // -- qualification --------------------------------------------------------

  @Post(':id/qualifications')
  @HttpCode(HttpStatus.CREATED)
  @Roles(...SUPPLIER_SIDE_ROLES)
  @ApiOperation({
    summary: 'Submit a qualification for one capability',
    description:
      'The supplier’s own organization only; a platform operator may not submit on a ' +
      'supplier’s behalf, because the submitter would then be the person who approves it. ' +
      'Evidence is a list of opaque document-service identifiers which this service stores ' +
      'and never resolves — nothing is fetched, opened or validated. A second submission is ' +
      'refused while one awaits a decision or one is already approved for that capability. ' +
      'No event is published: a submission is not a platform fact, and publishing one would ' +
      'put an in-progress application on a topic every service reads.',
  })
  async submitQualification(
    @Param('id') id: string,
    @Body(zodPipe(submitQualificationSchema)) dto: SubmitQualificationDto,
  ) {
    return this.qualifications.submit(id, dto);
  }

  @Post(':id/qualifications/:qualificationId/approve')
  @HttpCode(HttpStatus.OK)
  @Roles(...PLATFORM_ROLES)
  @ApiOperation({
    summary: 'Approve a submitted qualification',
    description:
      'An explicit human decision. Nothing computes, infers or times out into one: there is ' +
      'no automatic approval path anywhere in this service. A platform operator belonging to ' +
      'the supplier’s own organization is refused with 403 whatever role they hold. Only a ' +
      'SUBMITTED qualification may be approved; a decided one is terminal, and changing a ' +
      'decision means a new submission that leaves the first one standing in the record. ' +
      'Publishes SUPPLIER_QUALIFIED in the same transaction as the decision.',
  })
  async approveQualification(
    @Param('id') id: string,
    @Param('qualificationId') qualificationId: string,
    @Body(zodPipe(approveQualificationSchema)) dto: ApproveQualificationDto,
  ) {
    return this.qualifications.approve(id, qualificationId, dto);
  }

  @Post(':id/qualifications/:qualificationId/reject')
  @HttpCode(HttpStatus.OK)
  @Roles(...PLATFORM_ROLES)
  @ApiOperation({
    summary: 'Reject a submitted qualification',
    description:
      'The mirror of approval, with the same authorization and the same terminality. The ' +
      'stated `reason` is published on SUPPLIER_REJECTED so the supplier can act on it; the ' +
      'optional `note` is the reviewer’s private record and is never published.',
  })
  async rejectQualification(
    @Param('id') id: string,
    @Param('qualificationId') qualificationId: string,
    @Body(zodPipe(rejectQualificationSchema)) dto: RejectQualificationDto,
  ) {
    return this.qualifications.reject(id, qualificationId, dto);
  }

  // -- suspension -----------------------------------------------------------

  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  @Roles(...PLATFORM_ROLES)
  @ApiOperation({
    summary: 'Suspend a supplier',
    description:
      'A platform-operator decision about another organization; a caller from the supplier’s ' +
      'own organization is refused with 403 whatever role they hold. Nothing suspends ' +
      'automatically — there is no score, threshold or scheduled sweep. Suspension withholds ' +
      'qualifications rather than revoking them: a suspended supplier is returned as ' +
      'qualified for nothing, and reinstating restores exactly what was approved before with ' +
      'no new decision. Publishes SUPPLIER_SUSPENDED, whose `until` is always null because ' +
      'a suspension runs until an explicit reinstatement.',
  })
  async suspend(
    @Param('id') id: string,
    @Body(zodPipe(suspendSupplierSchema)) dto: SuspendSupplierDto,
  ) {
    return this.suspensions.suspend(id, dto);
  }

  @Post(':id/reinstate')
  @HttpCode(HttpStatus.OK)
  @Roles(...PLATFORM_ROLES)
  @ApiOperation({
    summary: 'Lift a suspension',
    description:
      'Closes the open suspension episode by stamping it with the lifting operator and ' +
      'reason; the episode is never deleted, so who suspended the supplier and why stays ' +
      'answerable. Publishes no event: the platform catalogue names no SUPPLIER_REINSTATED, ' +
      'so a consumer that hid this supplier on SUPPLIER_SUSPENDED must re-read this service ' +
      'rather than wait for one. That gap is recorded rather than closed by inventing an ' +
      'event this service has no mandate to add.',
  })
  async reinstate(
    @Param('id') id: string,
    @Body(zodPipe(reinstateSupplierSchema)) dto: ReinstateSupplierDto,
  ) {
    return this.suspensions.reinstate(id, dto);
  }
}
