import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles, zodPipe } from '@rasta/nest-common';
import { z } from 'zod';
import { OrganizationService } from './organization.service';
import {
  addLocationSchema,
  changeStatusSchema,
  createContactSchema,
  createOrganizationSchema,
  listOrganizationsQuerySchema,
  moveOrganizationSchema,
  nearbyQuerySchema,
  setPolicySchema,
  updateOrganizationSchema,
  type AddLocationDto,
  type ChangeStatusDto,
  type CreateContactDto,
  type CreateOrganizationDto,
  type ListOrganizationsQuery,
  type MoveOrganizationDto,
  type NearbyQuery,
  type SetPolicyDto,
  type UpdateOrganizationDto,
} from './dto';

const subtreeQuerySchema = z
  .object({ maxDepth: z.coerce.number().int().min(1).max(10).optional() })
  .strict();

/**
 * HTTP surface for organizations.
 *
 * No `@Roles` on the read endpoints: visibility here is subtree-based, not
 * role-based, and only the service knows which subtree the caller sits in.
 * Putting a role check on the route would be both too coarse and misleading.
 * Write endpoints that restructure the tree or set governance policy do carry
 * role guards, because those are platform-operator actions regardless of
 * position.
 */
@ApiTags('organizations')
@Controller({ path: 'organizations', version: '1' })
export class OrganizationController {
  constructor(private readonly organizations: OrganizationService) {}

  @Get()
  @ApiOperation({ summary: 'List organizations visible to the caller' })
  list(@Query(zodPipe(listOrganizationsQuerySchema)) query: ListOrganizationsQuery) {
    return this.organizations.list(query);
  }

  @Get('nearby')
  @ApiOperation({ summary: 'Organizations within a radius, nearest first' })
  nearby(@Query(zodPipe(nearbyQuerySchema)) query: NearbyQuery) {
    return this.organizations.nearby(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one organization with locations and contacts' })
  get(@Param('id') id: string) {
    return this.organizations.get(id);
  }

  @Get(':id/children')
  @ApiOperation({ summary: 'Direct children' })
  children(@Param('id') id: string) {
    return this.organizations.children(id);
  }

  @Get(':id/ancestors')
  @ApiOperation({ summary: 'Ancestors, root first — for breadcrumbs' })
  ancestors(@Param('id') id: string) {
    return this.organizations.ancestors(id);
  }

  @Get(':id/subtree')
  @ApiOperation({ summary: 'Whole subtree, inclusive' })
  subtree(
    @Param('id') id: string,
    @Query(zodPipe(subtreeQuerySchema)) query: { maxDepth?: number },
  ) {
    return this.organizations.subtree(id, query.maxDepth);
  }

  @Get(':id/policies')
  @ApiOperation({ summary: 'Effective governance policy, including inherited values' })
  policies(@Param('id') id: string) {
    return this.organizations.effectivePolicies(id);
  }

  @Post()
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN')
  @ApiOperation({ summary: 'Create an organization' })
  create(@Body(zodPipe(createOrganizationSchema)) dto: CreateOrganizationDto) {
    return this.organizations.create(dto);
  }

  @Patch(':id')
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN')
  @ApiOperation({ summary: 'Update an organization' })
  update(
    @Param('id') id: string,
    @Body(zodPipe(updateOrganizationSchema)) dto: UpdateOrganizationDto,
  ) {
    return this.organizations.update(id, dto);
  }

  @Post(':id/move')
  @HttpCode(200)
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN')
  @ApiOperation({ summary: 'Re-parent an organization and its subtree' })
  move(@Param('id') id: string, @Body(zodPipe(moveOrganizationSchema)) dto: MoveOrganizationDto) {
    return this.organizations.move(id, dto);
  }

  @Post(':id/status')
  @HttpCode(200)
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN')
  @ApiOperation({ summary: 'Change status; suspension and deactivation cascade downward' })
  changeStatus(@Param('id') id: string, @Body(zodPipe(changeStatusSchema)) dto: ChangeStatusDto) {
    return this.organizations.changeStatus(id, dto);
  }

  @Post(':id/policies')
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN')
  @ApiOperation({ summary: 'Set a governance policy value' })
  setPolicy(@Param('id') id: string, @Body(zodPipe(setPolicySchema)) dto: SetPolicyDto) {
    return this.organizations.setPolicy(id, dto);
  }

  @Post(':id/locations')
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN')
  @ApiOperation({ summary: 'Add a location' })
  addLocation(@Param('id') id: string, @Body(zodPipe(addLocationSchema)) dto: AddLocationDto) {
    return this.organizations.addLocation(id, dto);
  }

  @Post(':id/contacts')
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN')
  @ApiOperation({ summary: 'Add a contact' })
  addContact(@Param('id') id: string, @Body(zodPipe(createContactSchema)) dto: CreateContactDto) {
    return this.organizations.addContact(id, dto);
  }
}
