import { Injectable, Logger } from '@nestjs/common';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import { transactionNow } from '../shared/clock';
import type { TenderWorkflowKey } from '../approval/approval.state-machine';
import { TenderApprovalRepository } from './tender-approval.repository';

/** One act of an approval gate, granted or refused. */
export interface TenderApprovalAct {
  /** The tender owner's organization: the tenant the row lives in. */
  organizationId: string;
  tenderId: string;
  projectId: string;
  /** Null when the act named no request (a refusal before one was found). */
  requestId: string | null;
  workflowKey: TenderWorkflowKey;
  action: 'REQUEST' | 'GRANT' | 'REJECT' | 'EXECUTE' | 'STALE';
  outcome: 'GRANTED' | 'REFUSED';
  /** Why it was refused: a closed code; absent when granted. */
  refusalCode?: string;
  stepOrder?: number;
  actorUserId: string;
  actorOrganizationId: string;
  at: Date;
}

/**
 * Every request, decision, execution and refusal of a tender approval gate leaves a
 * `tender_approval_log` row and a `TENDER_APPROVAL_ACTION` event **in the same transaction as
 * the act** (CON-002 PR 11): a failed write fails the act. A refusal rolled back the transaction
 * that refused, so it is written in a transaction of its own (`recordRefusal`), best effort: it
 * never replaces the answer.
 */
@Injectable()
export class TenderApprovalAudit {
  private readonly logger = new Logger(TenderApprovalAudit.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly requests: TenderApprovalRepository,
    private readonly events: EventPublisher,
  ) {}

  async record(tx: ExtendedPrismaClient, act: TenderApprovalAct): Promise<void> {
    const refusalCode = act.outcome === 'REFUSED' ? (act.refusalCode ?? 'REFUSED') : null;
    await this.requests.insertLog(tx, {
      id: newId(ID_PREFIX.tenderApprovalLog),
      organizationId: act.organizationId,
      tenderId: act.tenderId,
      requestId: act.requestId,
      workflowKey: act.workflowKey,
      action: act.action,
      outcome: act.outcome,
      refusalCode,
      stepOrder: act.stepOrder ?? null,
      actorUserId: act.actorUserId,
      actorOrganizationId: act.actorOrganizationId,
      occurredAt: act.at,
    });
    await this.events.enqueue(tx, {
      eventName: 'TENDER_APPROVAL_ACTION',
      aggregateId: act.tenderId,
      organizationId: act.organizationId,
      payload: {
        tenderId: act.tenderId,
        projectId: act.projectId,
        organizationId: act.organizationId,
        workflowKey: act.workflowKey,
        requestId: act.requestId,
        action: act.action,
        outcome: act.outcome,
        refusalCode,
        stepOrder: act.stepOrder ?? null,
        actedBy: act.actorUserId,
        actorOrganizationId: act.actorOrganizationId,
        actedAt: act.at.toISOString(),
      },
      occurredAt: act.at,
    });
  }

  /** The refusal, in a transaction of its own; `act.at` is read there. */
  async recordRefusal(act: Omit<TenderApprovalAct, 'at' | 'outcome'>): Promise<void> {
    try {
      await this.prisma.transaction(async (tx) => {
        await this.record(tx, { ...act, outcome: 'REFUSED', at: await transactionNow(tx) });
      });
    } catch (cause) {
      this.logger.error(
        `could not record a refused tender approval act: ${cause instanceof Error ? cause.name : 'unknown'}`,
      );
    }
  }
}
