import { Injectable } from '@nestjs/common';
import { RastaError, actorIdentityUnknown, getContext } from '@rasta/nest-common';
import type { TenderApprovalRequest } from '../generated/prisma';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import { ID_PREFIX, newId } from '../events/publisher';
import { ApprovalService } from '../approval/approval.service';
import type { TenderWorkflowKey } from '../approval/approval.state-machine';
import type { StoredIdentity } from '../shared/stable-actor';
import { TenderApprovalAudit } from './tender-approval.audit';
import { TenderApprovalService } from './tender-approval.service';
import { refusalCodeOf } from './bid-access-audit';
import { approvalPolicyRequired } from './tender-approval.errors';
import { TenderApprovalRepository } from './tender-approval.repository';
import { requestStatus } from './tender-approval.dto';

/**
 * What a command asks to be approved: exactly what it would execute (CON-002 PR 11, Q-84).
 *
 * The tender and its version are in every request. An award adds the bid, its bidder, its rank in the
 * frozen matrix, whether the rank is shared, the justification and the digest of the matrix the choice
 * was made against; the standing read is what the authority is shown (it never replaces the read the
 * execution makes). A cancellation adds the reason in words and its closed code.
 */
export type GateBinding =
  | { workflowKey: 'tender.publication' }
  | {
      workflowKey: 'tender.award';
      bidId: string;
      bidderOrganizationId: string;
      rank: number;
      tied: boolean;
      justification: string | null;
      matrixDigest: string;
      standingAsOf: Date;
    }
  | {
      workflowKey: 'tender.cancellation';
      reason: string;
      reasonCode: 'OWNER_REQUEST' | 'NO_QUALIFIED_BID';
    };

/** The person who asks or executes: who, for which organization, and the identity a separation of duties compares. */
export interface GateCaller {
  userId: string;
  organizationId: string;
  identity: StoredIdentity;
}

export interface GateTender {
  organizationId: string;
  id: string;
  projectId: string;
  version: number;
}

/** What the gate found, in the transaction that asked it. */
export type Resolution =
  /** A round is being decided (opened by this call when `created`). The command answers 202. */
  | { kind: 'REQUESTED'; request: TenderApprovalRequest; created: boolean }
  /** Approved, unused, and exactly what the command would execute: execute, then `consume`. */
  | { kind: 'APPROVED'; request: TenderApprovalRequest }
  /** Approved, but no longer what the command would execute: ended (and audited) in this transaction; the command commits it and answers 409. */
  | { kind: 'STALE'; request: TenderApprovalRequest };

/**
 * The command side of a tender approval gate (CON-002 PR 11): the one place that opens a round for
 * `tender.publication`, `tender.award` and `tender.cancellation`, finds the approved one, and uses it up.
 *
 * ## The module is the project's, not a second one
 *
 * The policy, its steps, the round and the steps' states are `ApprovalService`'s and the state machine's;
 * `openRound` copies the steps of the policy in force into `approval` rows exactly as for a project, the
 * round carrying the tender's id. Who approves is what the policy says (organization and role), never
 * code. What this adds is the **binding** (`tender_approval_request`) and its **single use**.
 *
 * ## How a command uses it, under the tender's lock
 *
 * `resolve` is called with the tender locked, and tells the command which of three things holds:
 * a round is being decided (`REQUESTED`), an approved round is exactly what the command would execute
 * (`APPROVED`: execute, then `consume` — in the same transaction), or what was approved is no longer that
 * (`STALE`: the request is ended and audited here, and the command, once committed, answers 409). A pending
 * request that no longer matches is ended and replaced by a new one; an approved one that does not match is
 * never executed, and not silently replaced: the caller is told.
 *
 * What "the same" means: the tender version the request was made on, and — an award — the bid, its
 * bidder, rank and tie, the justification and the matrix digest; a cancellation — the reason and its code.
 * The database says it again: a request is used only once, by the transaction that moves the tender, on the
 * version it was made on (`tg_tender_approval_request_executed`, `tg_tender_status_requires_approval`).
 */
@Injectable()
export class TenderApprovalGate {
  constructor(
    private readonly rounds: ApprovalService,
    private readonly requests: TenderApprovalRepository,
    private readonly audit: TenderApprovalAudit,
    private readonly decisions: TenderApprovalService,
  ) {}

  /**
   * Runs a command on the caller's own tender; a refusal of it is audited (a `tender_approval_log` row and
   * its event, in a transaction of its own, best effort — it never replaces the answer), as a refused read of
   * a bid is (PR 10). Called only once the tender is shown to be the caller's: another organization's tender
   * is a 404 that is not logged.
   */
  async guarded<T>(
    tender: { organizationId: string; id: string; projectId: string },
    workflowKey: TenderWorkflowKey,
    caller: GateCaller,
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof RastaError) {
        await this.audit.recordRefusal({
          organizationId: tender.organizationId,
          tenderId: tender.id,
          projectId: tender.projectId,
          requestId: null,
          workflowKey,
          action: 'REQUEST',
          refusalCode: refusalCodeOf(error),
          actorUserId: caller.userId,
          actorOrganizationId: caller.organizationId,
        });
      }
      throw error;
    }
  }

  /**
   * The id of the policy in force for the workflow, re-confirmed as a project's is (Q-70 (7)); `null` when
   * none is in force. Asked **before** the transaction: no row lock is held across a network call.
   */
  confirmPolicy(organizationId: string, workflowKey: TenderWorkflowKey): Promise<string | null> {
    return this.rounds.confirmGoverningPolicy(organizationId, workflowKey);
  }

  /** Whether an approved, unused request of the workflow stands for the tender (a read: the command prepares to execute). */
  async hasApproved(
    organizationId: string,
    tenderId: string,
    workflowKey: TenderWorkflowKey,
  ): Promise<boolean> {
    const client = this.requests.client;
    const live = await this.requests.findLive(client, organizationId, tenderId, workflowKey);
    if (!live) return false;
    return requestStatus(live, await this.requests.steps(client, live)) === 'APPROVED';
  }

  async resolve(
    tx: ExtendedPrismaClient,
    input: {
      tender: GateTender;
      binding: GateBinding;
      /** From `confirmPolicy`: the round is not opened on any other policy (409 if one came into force since). */
      confirmedPolicyId: string;
      caller: GateCaller;
      at: Date;
    },
  ): Promise<Resolution> {
    const { tender, binding, caller, at } = input;
    const live = await this.requests.findLive(
      tx,
      tender.organizationId,
      tender.id,
      binding.workflowKey,
    );
    if (live) {
      const approved = requestStatus(live, await this.requests.steps(tx, live)) === 'APPROVED';
      if (this.covers(live, tender.version, binding)) {
        return approved
          ? { kind: 'APPROVED', request: live }
          : { kind: 'REQUESTED', request: live, created: false };
      }
      await this.decisions.endStale(tx, live, tender, caller.userId, caller.organizationId, at);
      if (approved) return { kind: 'STALE', request: live };
    }
    return {
      kind: 'REQUESTED',
      request: await this.open(tx, input),
      created: true,
    };
  }

  /** Uses the approved request up, in the transaction that executes what it approved. */
  async consume(
    tx: ExtendedPrismaClient,
    request: TenderApprovalRequest,
    tender: GateTender,
    caller: GateCaller,
    at: Date,
  ): Promise<void> {
    const matched = await this.requests.consume(tx, {
      organizationId: request.organizationId,
      id: request.id,
      by: caller.userId,
      identity: caller.identity,
      at,
    });
    if (matched === 0) throw RastaError.optimisticLockFailed('TenderApprovalRequest', request.id);
    await this.audit.record(tx, {
      organizationId: tender.organizationId,
      tenderId: tender.id,
      projectId: tender.projectId,
      requestId: request.id,
      workflowKey: request.workflowKey as TenderWorkflowKey,
      action: 'EXECUTE',
      outcome: 'GRANTED',
      actorUserId: caller.userId,
      actorOrganizationId: caller.organizationId,
      at,
    });
  }

  private covers(request: TenderApprovalRequest, version: number, binding: GateBinding): boolean {
    if (request.tenderVersion !== version) return false;
    switch (binding.workflowKey) {
      case 'tender.publication':
        return true;
      case 'tender.award':
        return (
          request.bidId === binding.bidId &&
          request.bidderOrganizationId === binding.bidderOrganizationId &&
          request.rank === binding.rank &&
          request.tied === binding.tied &&
          request.justification === binding.justification &&
          request.matrixDigest === binding.matrixDigest
        );
      case 'tender.cancellation':
        return request.reason === binding.reason && request.reasonCode === binding.reasonCode;
    }
  }

  private async open(
    tx: ExtendedPrismaClient,
    input: {
      tender: GateTender;
      binding: GateBinding;
      confirmedPolicyId: string;
      caller: GateCaller;
      at: Date;
    },
  ): Promise<TenderApprovalRequest> {
    const { tender, binding, caller, at } = input;
    // A request whose requester cannot later be told from its approver can never be approved: refuse it now.
    if (caller.identity.issuer === null || caller.identity.subject === null) {
      throw actorIdentityUnknown('the person who requests a tender approval');
    }
    const key: TenderWorkflowKey = binding.workflowKey;
    const id = newId(ID_PREFIX.tenderApproval);
    const round = await this.requests.nextRound(tx, tender.organizationId, tender.id, key);
    await this.requests.insert(tx, {
      id,
      organizationId: tender.organizationId,
      tenderId: tender.id,
      projectId: tender.projectId,
      workflowKey: key,
      round,
      tenderVersion: tender.version,
      bidId: binding.workflowKey === 'tender.award' ? binding.bidId : null,
      bidderOrganizationId:
        binding.workflowKey === 'tender.award' ? binding.bidderOrganizationId : null,
      rank: binding.workflowKey === 'tender.award' ? binding.rank : null,
      tied: binding.workflowKey === 'tender.award' ? binding.tied : null,
      justification: binding.workflowKey === 'tender.award' ? binding.justification : null,
      matrixDigest: binding.workflowKey === 'tender.award' ? binding.matrixDigest : null,
      standingVerdict: binding.workflowKey === 'tender.award' ? 'ELIGIBLE' : null,
      standingAsOf: binding.workflowKey === 'tender.award' ? binding.standingAsOf : null,
      reason: binding.workflowKey === 'tender.cancellation' ? binding.reason : null,
      reasonCode: binding.workflowKey === 'tender.cancellation' ? binding.reasonCode : null,
      requestedBy: caller.userId,
      requestedByIdentity: caller.identity,
      requestedAt: at,
      correlationId: getContext().correlationId,
    });

    // The steps of the policy in force, copied exactly as a project's round is (a bounded step has no
    // amount to be judged on here, so it does not apply; if none applies the request is refused).
    const outcome = await this.rounds.openRound(tx, {
      organizationId: tender.organizationId,
      projectId: tender.projectId,
      tenderId: tender.id,
      confirmedPolicyId: input.confirmedPolicyId,
      workflowKey: key,
      estimate: null,
      round,
      at,
    });
    if (!outcome.opened) throw approvalPolicyRequired(key, outcome.reason);

    await this.audit.record(tx, {
      organizationId: tender.organizationId,
      tenderId: tender.id,
      projectId: tender.projectId,
      requestId: id,
      workflowKey: key,
      action: 'REQUEST',
      outcome: 'GRANTED',
      actorUserId: caller.userId,
      actorOrganizationId: caller.organizationId,
      at,
    });
    const created = await this.requests.findLive(tx, tender.organizationId, tender.id, key);
    if (!created) throw RastaError.internal(`Request ${id} vanished inside its own transaction`);
    return created;
  }
}
