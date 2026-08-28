import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles, zodPipe } from '@rasta/nest-common';
import { AssignmentService } from './assignment.service';
import {
  createAssignmentSchema,
  endAssignmentSchema,
  listAssignmentsQuerySchema,
  type CreateAssignmentDto,
  type EndAssignmentDto,
  type ListAssignmentsQuery,
} from './dto';

/**
 * HTTP surface for assignments.
 *
 * The path is `/v1/assignments`, not `/v1/assets/{assetId}/assignments` as
 * docs/04 § 4.6 sketched. The gateway routes on the first path segment
 * (ADR-009), so anything under `assets/` reaches asset-service — and teaching
 * the gateway to route by second segment would give it knowledge of a domain
 * it deliberately does not have. The asset is a field in the body instead,
 * which is also more honest: an assignment belongs to fleet, not to the asset
 * (ADR-026).
 */
@ApiTags('assignments')
@Controller({ path: 'assignments', version: '1' })
export class AssignmentController {
  constructor(private readonly assignments: AssignmentService) {}

  // ---- Reads --------------------------------------------------------------

  @Get()
  @ApiOperation({
    summary: 'List assignments, newest first',
    description:
      'Filter by `driverId`, `assetId`, `active` (true/false) and a `from`/`to` window over the ' +
      'start time. A caller holding only DRIVER or OPERATOR sees their own assignments. ' +
      'Cursor-paginated.',
  })
  list(@Query(zodPipe(listAssignmentsQuerySchema)) query: ListAssignmentsQuery) {
    return this.assignments.list(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get one assignment',
    description: 'Returns 404 for an assignment in another organization — never 403.',
  })
  get(@Param('id') id: string) {
    return this.assignments.get(id);
  }

  // ---- Writes -------------------------------------------------------------

  @Post()
  @Roles('ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN')
  @ApiOperation({
    summary: 'Assign a driver to a machine',
    description:
      'Refuses with 422 if the driver already holds an assignment, if the machine is already ' +
      'assigned, or if the machine has been withdrawn from dispatch by asset-service or ' +
      'maintenance-service. Both exclusivity rules are enforced by partial unique indexes, so a ' +
      'concurrent duplicate is refused the same way as a sequential one (ADR-025).',
  })
  create(@Body(zodPipe(createAssignmentSchema)) dto: CreateAssignmentDto) {
    return this.assignments.create(dto);
  }

  @Post(':id/end')
  @HttpCode(200)
  @Roles('ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN')
  @ApiOperation({
    summary: 'End an assignment',
    description:
      'Publishes ASSIGNMENT_ENDED, which returns the machine to ACTIVE in its dossier. ' +
      'Returns 409 if the assignment has already ended.',
  })
  end(@Param('id') id: string, @Body(zodPipe(endAssignmentSchema)) dto: EndAssignmentDto) {
    return this.assignments.end(id, dto);
  }

  @Delete(':id')
  @HttpCode(200)
  @Roles('ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN')
  @ApiOperation({
    summary: 'End an assignment (alias of POST /assignments/{id}/end)',
    description:
      'Kept because docs/04 § 4.6 specifies DELETE for this operation. It does not delete the ' +
      'row: assignment history is the record of who was responsible for a machine and when, and ' +
      'a maintenance dispute years later depends on it still being there.',
  })
  endViaDelete(@Param('id') id: string) {
    return this.assignments.end(id, { reason: 'COMPLETED' });
  }
}
