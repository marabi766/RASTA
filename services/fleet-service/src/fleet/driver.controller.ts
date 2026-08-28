import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles, zodPipe } from '@rasta/nest-common';
import { DriverService } from './driver.service';
import { AssignmentService } from './assignment.service';
import {
  changeDriverStatusSchema,
  createDriverSchema,
  listAssignmentsQuerySchema,
  listDriversQuerySchema,
  updateDriverSchema,
  type ChangeDriverStatusDto,
  type CreateDriverDto,
  type ListAssignmentsQuery,
  type ListDriversQuery,
  type UpdateDriverDto,
} from './dto';

/**
 * HTTP surface for drivers.
 *
 * Controllers bind the route, validate the payload and delegate. Every
 * decision that depends on *which* driver is being touched lives in the
 * service, because only the service knows the driver's state and whether the
 * caller may see it (AGENTS.md A-10).
 *
 * `@Roles` here is the coarse filter — "may this kind of user do this kind of
 * thing". The object-level question, "may they see *this* driver", is answered
 * in the service against `access.ts`. Neither substitutes for the other
 * (docs/09 § 9.3).
 */
@ApiTags('drivers')
@Controller({ path: 'drivers', version: '1' })
export class DriverController {
  constructor(
    private readonly drivers: DriverService,
    private readonly assignments: AssignmentService,
  ) {}

  // ---- Reads --------------------------------------------------------------

  @Get()
  @ApiOperation({
    summary: 'List drivers in the requesting organization',
    description:
      'A caller holding only DRIVER or OPERATOR sees their own record and nothing else. ' +
      'Cursor-paginated; pass the returned `nextCursor` as `cursor`.',
  })
  list(@Query(zodPipe(listDriversQuerySchema)) query: ListDriversQuery) {
    return this.drivers.list(query);
  }

  @Get('me')
  @ApiOperation({
    summary: "The calling user's own driver record",
    description: 'Returns null when the caller is not registered as a driver here.',
  })
  async me() {
    const driver = await this.drivers.findForCurrentUser();
    return driver ? this.drivers.get(driver.id) : null;
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get one driver',
    description: 'Returns 404 for a driver in another organization — never 403 (docs/09).',
  })
  get(@Param('id') id: string) {
    return this.drivers.get(id);
  }

  @Get(':id/assignments')
  @ApiOperation({ summary: 'Assignment history for this driver, newest first' })
  assignmentHistory(
    @Param('id') id: string,
    @Query(zodPipe(listAssignmentsQuerySchema)) query: ListAssignmentsQuery,
  ) {
    return this.assignments.list({ ...query, driverId: id });
  }

  // ---- Writes -------------------------------------------------------------

  @Post()
  @Roles('ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN')
  @ApiOperation({
    summary: 'Register a driver',
    description:
      'Links an existing platform user to this organization as a driver. Returns 409 if that ' +
      'user is already registered as a driver here.',
  })
  create(@Body(zodPipe(createDriverSchema)) dto: CreateDriverDto) {
    return this.drivers.create(dto);
  }

  @Patch(':id')
  @Roles('ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN')
  @ApiOperation({
    summary: 'Update a driver',
    description: 'Returns 409 OPTIMISTIC_LOCK_FAILED if the record changed under the request.',
  })
  update(@Param('id') id: string, @Body(zodPipe(updateDriverSchema)) dto: UpdateDriverDto) {
    return this.drivers.update(id, dto);
  }

  @Post(':id/status')
  @HttpCode(200)
  // Barring a driver takes a person off the machines, so it sits with the
  // roles that answer for the fleet rather than with an operator.
  @Roles('ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN')
  @ApiOperation({
    summary: 'Change driver status',
    description:
      'Suspending or deactivating a driver also ends any assignment they are holding, and ' +
      'publishes ASSIGNMENT_ENDED for it. Returns 409 for an illegal transition.',
  })
  changeStatus(
    @Param('id') id: string,
    @Body(zodPipe(changeDriverStatusSchema)) dto: ChangeDriverStatusDto,
  ) {
    return this.drivers.changeStatus(id, dto);
  }
}
