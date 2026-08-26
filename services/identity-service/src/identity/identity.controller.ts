import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public, Roles, zodPipe } from '@rasta/nest-common';
import { IdentityService } from './identity.service';
import {
  approveRegistrationSchema,
  createMembershipSchema,
  createUserSchema,
  listUsersQuerySchema,
  rejectRegistrationSchema,
  revokeMembershipSchema,
  submitRegistrationSchema,
  switchOrganizationSchema,
  updateMembershipRolesSchema,
  updateUserSchema,
  type ApproveRegistrationDto,
  type CreateMembershipDto,
  type CreateUserDto,
  type ListUsersQuery,
  type RejectRegistrationDto,
  type RevokeMembershipDto,
  type SubmitRegistrationDto,
  type SwitchOrganizationDto,
  type UpdateMembershipRolesDto,
  type UpdateUserDto,
} from './dto';

/**
 * HTTP surface for identity.
 *
 * Controllers here do three things and nothing else: bind the route, validate
 * the payload, and delegate. Every authorization decision that depends on
 * *which* record is being touched lives in the service, because only the
 * service knows what the record is (AGENTS.md A-10).
 */
@ApiTags('identity')
@Controller({ path: 'users', version: '1' })
export class UserController {
  constructor(private readonly identity: IdentityService) {}

  @Get('me')
  @ApiOperation({ summary: 'The authenticated user, their memberships and effective roles' })
  getCurrentUser() {
    return this.identity.getCurrentUser();
  }

  @Post('me/active-organization')
  @HttpCode(200)
  @ApiOperation({ summary: 'Switch which organization subsequent requests act for' })
  switchOrganization(@Body(zodPipe(switchOrganizationSchema)) dto: SwitchOrganizationDto) {
    return this.identity.switchActiveOrganization(dto);
  }

  @Get()
  @Roles('ORGANIZATION_ADMIN', 'UNION_ADMIN')
  @ApiOperation({ summary: 'List users in the requesting organization' })
  list(@Query(zodPipe(listUsersQuerySchema)) query: ListUsersQuery) {
    return this.identity.listUsers(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one user' })
  get(@Param('id') id: string) {
    return this.identity.getUser(id);
  }

  @Post()
  @Roles('ORGANIZATION_ADMIN', 'UNION_ADMIN')
  @ApiOperation({ summary: 'Create an already-approved user' })
  create(@Body(zodPipe(createUserSchema)) dto: CreateUserDto) {
    return this.identity.createUser(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a user profile' })
  update(@Param('id') id: string, @Body(zodPipe(updateUserSchema)) dto: UpdateUserDto) {
    return this.identity.updateUser(id, dto);
  }

  @Post(':id/memberships')
  @Roles('ORGANIZATION_ADMIN', 'UNION_ADMIN')
  @ApiOperation({ summary: 'Add the user to an organization' })
  addMembership(
    @Param('id') id: string,
    @Body(zodPipe(createMembershipSchema)) dto: CreateMembershipDto,
  ) {
    return this.identity.addMembership(id, dto);
  }
}

@ApiTags('identity')
@Controller({ path: 'memberships', version: '1' })
export class MembershipController {
  constructor(private readonly identity: IdentityService) {}

  @Post(':id/roles')
  @HttpCode(200)
  @Roles('ORGANIZATION_ADMIN', 'UNION_ADMIN')
  @ApiOperation({ summary: 'Replace the roles held in this organization' })
  updateRoles(
    @Param('id') id: string,
    @Body(zodPipe(updateMembershipRolesSchema)) dto: UpdateMembershipRolesDto,
  ) {
    return this.identity.updateMembershipRoles(id, dto);
  }

  @Post(':id/revoke')
  @HttpCode(204)
  @Roles('ORGANIZATION_ADMIN', 'UNION_ADMIN')
  @ApiOperation({ summary: 'Revoke a membership' })
  async revoke(
    @Param('id') id: string,
    @Body(zodPipe(revokeMembershipSchema)) dto: RevokeMembershipDto,
  ): Promise<void> {
    await this.identity.revokeMembership(id, dto);
  }
}

@ApiTags('identity')
@Controller({ path: 'registration-requests', version: '1' })
export class RegistrationController {
  constructor(private readonly identity: IdentityService) {}

  /**
   * The one endpoint on this service reachable without a token.
   *
   * It cannot grant access: it creates a PENDING user with no Keycloak account
   * and a reviewable request. Rate limiting at the gateway is what stops it
   * being used to enumerate or to flood the review queue.
   */
  @Post()
  @Public('Self-registration must be reachable before the applicant has an account')
  @ApiOperation({ summary: 'Submit a request to join the platform' })
  submit(@Body(zodPipe(submitRegistrationSchema)) dto: SubmitRegistrationDto) {
    return this.identity.submitRegistration(dto);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @Roles('UNION_ADMIN')
  @ApiOperation({ summary: 'Approve a registration and provision the account' })
  approve(
    @Param('id') id: string,
    @Body(zodPipe(approveRegistrationSchema)) dto: ApproveRegistrationDto,
  ) {
    return this.identity.approveRegistration(id, dto);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @Roles('UNION_ADMIN')
  @ApiOperation({ summary: 'Reject a registration, with a required reason' })
  reject(
    @Param('id') id: string,
    @Body(zodPipe(rejectRegistrationSchema)) dto: RejectRegistrationDto,
  ) {
    return this.identity.rejectRegistration(id, dto);
  }
}
