import { Injectable } from '@nestjs/common';
import { RastaError, runUnscoped } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import type { ScanResult } from '../scanning/scanner.port';
import type { ListDocumentsQuery } from './dto';

/**
 * Every read and write of this service's own tables.
 *
 * ## Where the tenant guard is crossed, and why
 *
 * Two places, both narrow and both for the same structural reason: an id
 * lookup has to find the row **before** anybody can decide whether the caller
 * may see it. A scoped read would return `null` for another tenant's document,
 * which sounds safe and is subtly wrong — the service could then never
 * distinguish "does not exist" from "belongs to someone else", and the
 * object-level check in `access.ts` would have nothing to check. So the row is
 * located unscoped and handed straight to a check that answers `404` either
 * way (AGENTS.md A-04's written-reason exception).
 *
 * The list path is **not** one of those places. It is scoped by organization
 * in the query itself, because a listing has no id to check against.
 */
@Injectable()
export class DocumentRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Upload intents ----------------------------------------------------

  async createIntent(input: {
    id: string;
    organizationId: string;
    objectKey: string;
    documentClass: string;
    declaredContentType: string;
    declaredSizeBytes: number;
    declaredFilename: string;
    expiresAt: Date;
    createdBy: string;
  }) {
    return this.prisma.client.uploadIntent.create({
      // JUSTIFIED-ANY: the generated enum type is structurally a string union
      // and the class was validated by the DTO before reaching here.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: input as any,
    });
  }

  /**
   * Locates an intent by id, without a tenant scope.
   *
   * The caller checks ownership immediately (`assertIntentRedeemable`), which
   * answers `404` for another tenant's intent — so a stranger cannot learn
   * that an id exists.
   */
  async findIntent(id: string) {
    return runUnscoped('an upload intent is located before its owner is checked', () =>
      this.prisma.client.uploadIntent.findUnique({ where: { id } }),
    );
  }

  async markIntentExpired(id: string): Promise<void> {
    await runUnscoped('the expiry state is recorded on the intent it belongs to', () =>
      this.prisma.client.uploadIntent.updateMany({
        where: { id, state: 'ISSUED' },
        data: { state: 'EXPIRED' },
      }),
    );
  }

  /**
   * Redeems an intent, exactly once.
   *
   * The `state: 'ISSUED'` predicate is the concurrency control: two requests
   * finalizing the same intent race here, and the loser updates zero rows and
   * is refused. Without it both would create a document against one object.
   */
  async consumeIntent(
    tx: ExtendedPrismaClient,
    intentId: string,
    documentId: string,
  ): Promise<void> {
    const changed = await runUnscoped('the intent is redeemed by the document it produced', () =>
      tx.uploadIntent.updateMany({
        where: { id: intentId, state: 'ISSUED' },
        data: { state: 'CONSUMED', consumedAt: new Date(), consumedDocumentId: documentId },
      }),
    );

    if (changed.count === 0) {
      // Rolls the whole transaction back, including the document row and its
      // event — so a lost race leaves nothing behind.
      throw RastaError.businessRule('This upload intent has already been used', {
        uploadIntentId: intentId,
      });
    }
  }

  // ---- Documents ---------------------------------------------------------

  async createDocument(
    tx: ExtendedPrismaClient,
    input: {
      id: string;
      organizationId: string;
      objectKey: string;
      documentClass: string;
      contentType: string;
      sizeBytes: number;
      filename: string;
      checksum: string | null;
      scan: ScanResult;
      ownerResourceType: string | null;
      ownerResourceId: string | null;
      uploadIntentId: string;
      createdBy: string;
    },
  ) {
    return tx.document.create({
      data: {
        id: input.id,
        organizationId: input.organizationId,
        objectKey: input.objectKey,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        documentClass: input.documentClass as any,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        filename: input.filename,
        checksum: input.checksum,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        scanState: input.scan.verdict as any,
        scanEngine: input.scan.engine,
        scanVersion: input.scan.engineVersion,
        scanSignature: input.scan.signature,
        scannedAt: input.scan.scannedAt,
        ownerResourceType: input.ownerResourceType,
        ownerResourceId: input.ownerResourceId,
        uploadIntentId: input.uploadIntentId,
        createdBy: input.createdBy,
      },
    });
  }

  /**
   * Locates a document by id, without a tenant scope.
   *
   * As with intents: the caller checks ownership immediately and answers `404`
   * for a stranger, so this crossing never widens what anyone can see.
   */
  async findById(id: string) {
    return runUnscoped('a document is located before its owner is checked', () =>
      this.prisma.client.document.findUnique({ where: { id } }),
    );
  }

  /**
   * The caller's own documents, scoped in the query.
   *
   * One row more than asked for, so the caller can tell whether another page
   * exists without a second count query.
   */
  async list(organizationId: string, query: ListDocumentsQuery) {
    return this.prisma.client.document.findMany({
      where: {
        organizationId,
        ...(query.includeDeleted ? {} : { status: 'REGISTERED' }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(query.documentClass ? { documentClass: query.documentClass as any } : {}),
        ...(query.ownerResourceType ? { ownerResourceType: query.ownerResourceType } : {}),
        ...(query.ownerResourceId ? { ownerResourceId: query.ownerResourceId } : {}),
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    });
  }

  /**
   * Writes the deletion tombstone.
   *
   * Conditional on the version, so two concurrent deletions cannot both
   * believe they were the one that deleted it — and the second is answered
   * from the row rather than by writing a second tombstone over the first,
   * which would overwrite the original actor and reason.
   */
  async markDeleted(
    tx: ExtendedPrismaClient,
    documentId: string,
    input: { deletedAt: Date; deletedBy: string; reason: string; expectedVersion: number },
  ) {
    const changed = await tx.document.updateMany({
      where: { id: documentId, status: 'REGISTERED', version: input.expectedVersion },
      data: {
        status: 'DELETED',
        deletedAt: input.deletedAt,
        deletedBy: input.deletedBy,
        deletionReason: input.reason,
        version: { increment: 1 },
      },
    });

    if (changed.count === 0) {
      throw RastaError.optimisticLockFailed('Document', documentId);
    }

    return tx.document.findUniqueOrThrow({ where: { id: documentId } });
  }
}
