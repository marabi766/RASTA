import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles, zodPipe } from '@rasta/nest-common';
import { ScheduleService } from './schedule.service';
import {
  changeScheduleStatusSchema,
  createScheduleSchema,
  dueSchedulesQuerySchema,
  listSchedulesQuerySchema,
  updateScheduleSchema,
  type ChangeScheduleStatusDto,
  type CreateScheduleDto,
  type DueSchedulesQuery,
  type ListSchedulesQuery,
  type UpdateScheduleDto,
} from './dto';

/**
 * HTTP surface for service schedules.
 *
 * The path is `/v1/maintenance-schedules`, which is what the gateway's routing
 * table already sends here (`services/api-gateway/src/config/routes.ts`) and
 * what docs/04 § 4.7 specifies. No gateway change was needed to bring this
 * service online — the routes for `maintenance-schedules`,
 * `maintenance-requests` and `repair-orders` were written when the table was.
 */
@ApiTags('maintenance-schedules')
@Controller({ path: 'maintenance-schedules', version: '1' })
export class ScheduleController {
  constructor(private readonly schedules: ScheduleService) {}

  // ---- Reads --------------------------------------------------------------

  /**
   * Declared before `:id`, or Nest would match `due` as an identifier and
   * return 404 for the one endpoint docs/04 names by path.
   */
  @Get('due')
  @ApiOperation({
    summary: 'What needs servicing',
    description:
      'Every active schedule assessed against the machine current meter and the clock. The ' +
      'verdict is computed on each call and never read from a stored flag, so a background ' +
      'scan that has not run cannot make an overdue machine look compliant. Each entry names ' +
      'the trigger that came due — time, hours or kilometres — and how much is left. Pass ' +
      '`includeNotDue=true` to see the whole picture, or `at` to assess as at a point in time.',
  })
  due(@Query(zodPipe(dueSchedulesQuerySchema)) query: DueSchedulesQuery) {
    return this.schedules.listDue(query);
  }

  @Get()
  @ApiOperation({
    summary: 'List service schedules',
    description:
      'Filter by `assetId`, `status` and `maintenanceType`. Cursor-paginated. Returns the ' +
      'rules themselves; for whether they are due, use `/maintenance-schedules/due`.',
  })
  list(@Query(zodPipe(listSchedulesQuerySchema)) query: ListSchedulesQuery) {
    return this.schedules.list(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get one schedule',
    description: 'Returns 404 for a schedule in another organization — never 403.',
  })
  get(@Param('id') id: string) {
    return this.schedules.get(id);
  }

  // ---- Writes -------------------------------------------------------------

  @Post()
  @Roles('ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN')
  @ApiOperation({
    summary: 'Define a service rule for a machine',
    description:
      'At least one of `intervalDays`, `intervalHours` or `intervalKilometres` is required; a ' +
      'schedule with none never comes due. When more than one is set the schedule falls due on ' +
      'whichever is reached first. The platform supplies no intervals of its own — every value ' +
      'comes from the caller. Unless `lastServiced*` is given, the first cycle is anchored to ' +
      'the machine current meter, so a schedule added to a machine with hours already on it is ' +
      'not instantly overdue.',
  })
  create(@Body(zodPipe(createScheduleSchema)) dto: CreateScheduleDto) {
    return this.schedules.create(dto);
  }

  @Patch(':id')
  @Roles('ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN')
  @ApiOperation({
    summary: 'Edit a schedule, or re-anchor it',
    description:
      'Re-anchoring with `lastServicedHourMeter` is the supported repair for a replaced hour ' +
      'meter: the usage meter never moves backwards, so the schedule is moved to meet the new ' +
      'instrument rather than the usage history being rewritten. Any edit re-arms the due ' +
      'announcement, because the due point has moved.',
  })
  update(@Param('id') id: string, @Body(zodPipe(updateScheduleSchema)) dto: UpdateScheduleDto) {
    return this.schedules.update(id, dto);
  }

  @Post(':id/status')
  @HttpCode(200)
  @Roles('ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN')
  @ApiOperation({
    summary: 'Pause, resume or archive a schedule',
    description:
      'A reason is required. A schedule quietly switched off is a machine that quietly stops ' +
      'being serviced, and that is exactly the decision someone will need to explain later. ' +
      'Archiving is terminal.',
  })
  changeStatus(
    @Param('id') id: string,
    @Body(zodPipe(changeScheduleStatusSchema)) dto: ChangeScheduleStatusDto,
  ) {
    return this.schedules.changeStatus(id, dto);
  }
}
