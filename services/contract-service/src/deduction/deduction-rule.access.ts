import { Inject, Injectable } from '@nestjs/common';
import {
  RastaError,
  getContext,
  currentActor,
  actorIdentityUnknown,
  type ActorIdentity,
} from '@rasta/nest-common';
import { ENV } from '../tokens';
import type { ContractEnv } from '../config/env';
import {
  assertNotAuditor,
  assertNotServiceCaller,
  CONTRACTOR_ROLE,
  SUPER_ROLE,
} from '../access/access';
import { storageText } from './dto';

@Injectable()
export class DeductionRuleAccess {
  constructor(@Inject(ENV) private readonly env: ContractEnv) {}

  assertWriter(): { organizationId: string; actor: ActorIdentity } {
    assertNotAuditor();
    assertNotServiceCaller();
    const context = getContext();
    if (
      context.authType !== 'USER' ||
      !context.organizationId ||
      !storageText(context.organizationId) ||
      context.roles.some((role) => role === SUPER_ROLE || role === CONTRACTOR_ROLE) ||
      !this.env.CONTRACT_DEDUCTION_WRITER_ROLES.some((role) => context.roles.includes(role))
    ) {
      throw RastaError.forbidden('An authorized employer writer is required');
    }
    const actor = currentActor({ requirePlatformUserId: true });
    if (
      [actor.userId, actor.issuer, actor.subject].some(
        (value) => value === null || value.trim() === '' || !storageText(value),
      )
    )
      throw actorIdentityUnknown('The deduction proposal requires a verified actor');
    return { organizationId: context.organizationId, actor };
  }
}
