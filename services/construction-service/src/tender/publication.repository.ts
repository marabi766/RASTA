import { Injectable } from '@nestjs/common';
import type { TenderInvitation } from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import type { WrappedKey } from './sealing/key-provider';

/**
 * Invitations to a restricted tender, and the tender's key.
 *
 * Tenant-scoped through the guard like every tender table: another
 * organization's invitations and key are never found. The key row is written
 * once, in the transaction that publishes (`tender_key.tender_id` is its primary
 * key), and only ever read again by the step that opens the bids; there is no
 * read of it in this class on purpose.
 */

/**
 * The approval workflow that gates publication (Q-84). Not yet one of the
 * approval module's `WORKFLOW_KEYS`: policies for it cannot be written until the
 * round is wired (PR 11), so until then none is ever in force and publishing is
 * refused with `APPROVAL_POLICY_REQUIRED` — the fail-closed state, by design.
 */
export const PUBLICATION_WORKFLOW_KEY = 'tender.publication';

export interface InvitationCreateInput {
  id: string;
  organizationId: string;
  tenderId: string;
  invitedOrganizationId: string;
  actor: string;
  at: Date;
}

export interface KeyCreateInput {
  organizationId: string;
  tenderId: string;
  keyId: string;
  publicKeyPem: string;
  wrapped: WrappedKey;
  actor: string;
  at: Date;
}

@Injectable()
export class PublicationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createInvitation(tx: ExtendedPrismaClient, input: InvitationCreateInput): Promise<void> {
    await tx.tenderInvitation.create({
      data: {
        id: input.id,
        organizationId: input.organizationId,
        tenderId: input.tenderId,
        invitedOrganizationId: input.invitedOrganizationId,
        invitedAt: input.at,
        invitedBy: input.actor,
      },
    });
  }

  async findInvitation(
    tenderId: string,
    invitationId: string,
    client: ExtendedPrismaClient = this.prisma.client,
  ): Promise<TenderInvitation | null> {
    return client.tenderInvitation.findFirst({ where: { id: invitationId, tenderId } });
  }

  /**
   * Whether the organization in context has an ACTIVE `tender.publication`
   * approval policy (Q-84). Under the tenant guard: another organization's policy
   * is never seen. Only ACTIVE counts, never DRAFT, PENDING or REJECTED.
   */
  async hasActivePublicationPolicy(client: ExtendedPrismaClient): Promise<boolean> {
    const count = await client.approvalPolicy.count({
      where: { workflowKey: PUBLICATION_WORKFLOW_KEY, status: 'ACTIVE' },
    });
    return count > 0;
  }

  async countInvitations(tx: ExtendedPrismaClient, tenderId: string): Promise<number> {
    return tx.tenderInvitation.count({ where: { tenderId } });
  }

  /** Oldest first: the order they were made in. */
  async listInvitations(
    tenderId: string,
    filter: { cursor?: string; limit: number },
  ): Promise<TenderInvitation[]> {
    return this.prisma.client.tenderInvitation.findMany({
      where: { tenderId, ...(filter.cursor ? { id: { gt: filter.cursor } } : {}) },
      orderBy: { id: 'asc' },
      take: filter.limit + 1,
    });
  }

  async createKey(tx: ExtendedPrismaClient, input: KeyCreateInput): Promise<void> {
    await tx.tenderKey.create({
      data: {
        tenderId: input.tenderId,
        organizationId: input.organizationId,
        keyId: input.keyId,
        publicKeyPem: input.publicKeyPem,
        kekId: input.wrapped.kekId,
        // Copied into plain `Uint8Array`s: Prisma's `Bytes` wants one backed by an
        // `ArrayBuffer`, which a Node `Buffer` (possibly pooled) does not promise.
        wrapNonce: new Uint8Array(input.wrapped.nonce),
        wrappedPrivateKey: new Uint8Array(input.wrapped.ciphertext),
        wrapTag: new Uint8Array(input.wrapped.tag),
        createdAt: input.at,
        createdBy: input.actor,
      },
    });
  }
}
