import { Injectable } from '@nestjs/common';
import { getContext, getOrganizationId, RastaError } from '@rasta/nest-common';
import { isoDateTime } from '@rasta/contracts';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { PROJECT_STATES } from './project.state-machine';

export const COMPLETION_READ_CALLER = 'contract-service';

/** Minimal source fact for D-081. A non-COMPLETED project is never completion proof. */
export const projectCompletionFactSchema = z
  .object({
    projectId: z.string().min(1).max(128),
    organizationId: z.string().min(1).max(128),
    status: z.enum(PROJECT_STATES),
    version: z.number().int().min(1),
    completedAt: z
      .string()
      .check(isoDateTime({ offset: false }))
      .nullable(),
    completedBy: z.string().min(1).max(128).nullable(),
  })
  .strict();

export type ProjectCompletionFact = z.infer<typeof projectCompletionFactSchema>;

/**
 * ADR-061 source confirmation, for either project completion path (configured final approvals or
 * Q-71's interim 100% progress rule). Read the owner's stored terminal state; never reconstruct
 * authority from employer membership or today's policy. No project content or money is returned.
 */
@Injectable()
export class ProjectCompletionService {
  constructor(private readonly prisma: PrismaService) {}

  async fact(id: string): Promise<ProjectCompletionFact> {
    const context = getContext();
    // AllowService gates service tokens at HTTP; user tokens also need this service-level gate.
    if (context.authType !== 'SERVICE' || context.callerService !== COMPLETION_READ_CALLER) {
      throw RastaError.forbidden('This endpoint is reserved for the contract completion consumer');
    }
    const organizationId = getOrganizationId();
    // One SQL statement: the state, version and completion metadata are one snapshot, even when
    // completion commits during the read. Tenant guard plus an explicit signed-tenant predicate.
    const row = await this.prisma.client.project.findFirst({
      where: { organizationId, id },
      select: {
        id: true,
        organizationId: true,
        status: true,
        version: true,
        statusChangedAt: true,
        statusChangedBy: true,
      },
    });
    if (!row) throw RastaError.notFound('Project', id);
    return {
      projectId: row.id,
      organizationId: row.organizationId,
      status: row.status,
      version: row.version,
      completedAt: row.status === 'COMPLETED' ? row.statusChangedAt.toISOString() : null,
      completedBy: row.status === 'COMPLETED' ? row.statusChangedBy : null,
    };
  }
}
