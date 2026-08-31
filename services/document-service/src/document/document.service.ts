import { Inject, Injectable } from '@nestjs/common';
import { RastaError, getContext, getOrganizationId } from '@rasta/nest-common';
import { PrismaService } from '../prisma/prisma.service';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import { DOCUMENT_EVENTS } from '../events/events';
import { ENV, OBJECT_STORAGE, MALWARE_SCANNER } from '../tokens';
import { SERVICE_NAME, type DocumentEnv } from '../config/env';
import type { ObjectStorage } from '../storage/storage.port';
import type { MalwareScanner, ScanResult } from '../scanning/scanner.port';
import { buildObjectKey, isWellFormedKey, keyBelongsTo } from '../storage/object-key';
import { MAGIC_PREFIX_BYTES, declarationMatches, detectMime } from '../content/magic-number';
import {
  assertDeclarationAllowed,
  assertObjectAllowed,
  sanitizeFilename,
  type DocumentClass,
} from '../content/policy';
import {
  assertCanHandleDocuments,
  assertDocumentReadable,
  assertDocumentWritable,
  assertIntentRedeemable,
} from '../access/access';
import {
  documentsDeletedTotal,
  documentsFinalizedTotal,
  downloadUrlsIssuedTotal,
  downloadUrlsRefusedTotal,
  storageOperationSeconds,
  uploadUrlsIssuedTotal,
} from '../observability/metrics';
import type {
  DeleteDocumentDto,
  FinalizeDocumentDto,
  ListDocumentsQuery,
  RequestUploadUrlDto,
} from './dto';
import { DocumentRepository } from './document.repository';
import { canDownload, type DownloadDecision } from './download-policy';

/**
 * The document lifecycle.
 *
 * ## The file is never here
 *
 * ADR-014's central rule, and the reason this class has no upload method: the
 * client is handed a signed URL and uploads straight to storage. The only
 * bytes this service ever holds are the {@link MAGIC_PREFIX_BYTES}-byte header
 * it reads back to establish what the object actually is — a header, not a
 * document.
 *
 * ## Why finalize is a separate call
 *
 * Because the upload does not go through us, we cannot know it happened. The
 * client tells us, and we verify rather than believe: the object must exist,
 * its size comes from storage metadata, and its type comes from its bytes.
 * ADR-014 names the cost of this split honestly — an object can be uploaded
 * and never finalized, leaving it orphaned — and that is a cleanup job, not a
 * correctness problem, because an unfinalized object has no metadata row and
 * is therefore invisible and undownloadable.
 */
@Injectable()
export class DocumentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: DocumentRepository,
    private readonly events: EventPublisher,
    @Inject(ENV) private readonly env: DocumentEnv,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
  ) {}

  // =========================================================================
  // 1. Upload intent
  // =========================================================================

  /**
   * Issues permission to upload one object.
   *
   * The object key is generated here and never leaves this service in a form
   * the client can act on: the client receives a signed URL that already
   * contains it, and finalizes by intent id. That is what makes key
   * substitution structurally impossible rather than merely checked.
   */
  async requestUploadUrl(dto: RequestUploadUrlDto): Promise<{
    uploadIntentId: string;
    uploadUrl: string;
    expiresAt: Date;
    maxBytes: number;
  }> {
    assertCanHandleDocuments();

    const organizationId = getOrganizationId();
    const actor = getContext().userId ?? SERVICE_NAME;
    const documentClass = dto.documentClass as DocumentClass;

    // The client's claims, checked before a credential is issued.
    assertDeclarationAllowed(
      documentClass,
      dto.contentType,
      dto.sizeBytes,
      this.env.DOCUMENT_MAX_BYTES,
    );

    const objectKey = buildObjectKey(organizationId, documentClass);
    const expiresAt = new Date(Date.now() + this.env.DOCUMENT_UPLOAD_INTENT_TTL_SECONDS * 1000);

    const intent = await this.repository.createIntent({
      id: newId(ID_PREFIX.uploadIntent),
      organizationId,
      objectKey,
      documentClass,
      declaredContentType: dto.contentType.trim().toLowerCase(),
      declaredSizeBytes: dto.sizeBytes,
      declaredFilename: sanitizeFilename(dto.filename),
      expiresAt,
      createdBy: actor,
    });

    const uploadUrl = await this.timeStorage('createUploadUrl', () =>
      this.storage.createUploadUrl({
        objectKey,
        contentType: intent.declaredContentType,
        // The URL is shorter-lived than the intent: a client that uploaded at
        // the last second can still finalize, but the credential itself is
        // gone.
        expiresInSeconds: this.env.DOCUMENT_SIGNED_URL_TTL_SECONDS,
      }),
    );

    uploadUrlsIssuedTotal.inc({ service: SERVICE_NAME, document_class: documentClass });

    return {
      uploadIntentId: intent.id,
      uploadUrl,
      expiresAt,
      maxBytes: Math.min(
        this.env.DOCUMENT_MAX_BYTES,
        // Echoed so a client can enforce the same ceiling before uploading.
        dto.sizeBytes,
      ),
    };
  }

  // =========================================================================
  // 2. Finalize
  // =========================================================================

  /**
   * Confirms the object and registers the document.
   *
   * Everything the client told us at intent time is re-checked against what
   * storage actually holds. A client that declared a PDF and uploaded an HTML
   * page is refused here — which is the case the extension and the header
   * cannot catch, and the reason ADR-014 asks for magic-number inspection.
   */
  async finalize(dto: FinalizeDocumentDto): Promise<DocumentView> {
    assertCanHandleDocuments();

    const organizationId = getOrganizationId();
    const actor = getContext().userId ?? SERVICE_NAME;

    const intent = await this.repository.findIntent(dto.uploadIntentId);
    if (!intent) throw RastaError.notFound('UploadIntent', dto.uploadIntentId);

    // Object-level authorization before anything is read from storage.
    assertIntentRedeemable(intent);

    // A replay of a successful finalize returns what the first one produced,
    // rather than a conflict. The client cannot tell whether its first request
    // was lost in the response or never arrived, and the honest answer to both
    // is the same document (AGENTS.md A-09).
    if (intent.state === 'CONSUMED') {
      if (!intent.consumedDocumentId) {
        throw RastaError.internal('A consumed upload intent names no document');
      }
      const existing = await this.repository.findById(intent.consumedDocumentId);
      if (!existing) throw RastaError.internal('The document this intent produced is missing');
      return toView(existing, this.scanner);
    }

    if (intent.state === 'EXPIRED' || intent.expiresAt.getTime() <= Date.now()) {
      // Marked rather than merely reported, so a later attempt sees the state
      // rather than re-deriving it from a clock that may have moved.
      await this.repository.markIntentExpired(intent.id);
      throw RastaError.businessRule('This upload intent has expired', {
        uploadIntentId: intent.id,
      });
    }

    // Defence in depth: the key came from our own row, so this can only fail
    // if something wrote a malformed key into the table.
    if (!isWellFormedKey(intent.objectKey) || !keyBelongsTo(intent.objectKey, organizationId)) {
      throw RastaError.forbidden('This upload intent does not belong to your organization');
    }

    const metadata = await this.timeStorage('head', () => this.storage.head(intent.objectKey));
    if (!metadata) {
      throw RastaError.businessRule('No object was uploaded for this intent', {
        uploadIntentId: intent.id,
      });
    }

    const prefix = await this.timeStorage('readPrefix', () =>
      this.storage.readPrefix(intent.objectKey, MAGIC_PREFIX_BYTES),
    );

    const detected = detectMime(prefix);
    if (!detected) {
      throw RastaError.businessRule('The uploaded content is not a supported document format', {
        uploadIntentId: intent.id,
      });
    }

    // The declared type is compared with the detected one and the mismatch is
    // reported as a mismatch — not silently corrected to the detected value.
    // A client that believes it uploaded a PDF and actually uploaded something
    // else has a bug worth learning about.
    if (!declarationMatches(intent.declaredContentType, detected)) {
      throw RastaError.businessRule(
        'The uploaded content does not match the declared content type',
        {
          uploadIntentId: intent.id,
          declared: intent.declaredContentType,
          detected,
        },
      );
    }

    assertObjectAllowed(
      intent.documentClass as DocumentClass,
      detected,
      metadata.sizeBytes,
      this.env.DOCUMENT_MAX_BYTES,
    );

    // Scanning happens before the row is written, so the state stored is the
    // state that was actually reached. In the MVP this records `NOT_SCANNED`
    // (Q-18) — an honest verdict, not a clean one.
    const scan = await this.scanner.scan({
      objectKey: intent.objectKey,
      sizeBytes: metadata.sizeBytes,
      contentType: detected,
    });

    const documentId = newId(ID_PREFIX.document);

    const created = await this.prisma.transaction(async (tx) => {
      const document = await this.repository.createDocument(tx, {
        id: documentId,
        organizationId,
        objectKey: intent.objectKey,
        documentClass: intent.documentClass,
        contentType: detected,
        sizeBytes: metadata.sizeBytes,
        filename: intent.declaredFilename,
        checksum: metadata.etag,
        scan,
        ownerResourceType: dto.ownerResourceType ?? null,
        ownerResourceId: dto.ownerResourceId ?? null,
        uploadIntentId: intent.id,
        createdBy: actor,
      });

      await this.repository.consumeIntent(tx, intent.id, documentId);

      await this.events.enqueue(tx, {
        eventName: DOCUMENT_EVENTS.DOCUMENT_UPLOADED,
        aggregateId: documentId,
        organizationId,
        payload: {
          documentId,
          organizationId,
          documentClass: intent.documentClass,
          contentType: detected,
          sizeBytes: metadata.sizeBytes,
          filename: intent.declaredFilename,
          // Carried so no consumer reads the event's existence as a clean
          // bill of health: DOCUMENT_UPLOADED means "confirmed and
          // registered", and in MVP this field says `NOT_SCANNED`.
          scanState: scanStateOf(scan),
          ownerResourceType: dto.ownerResourceType ?? null,
          ownerResourceId: dto.ownerResourceId ?? null,
          uploadedBy: actor,
          uploadedAt: document.createdAt.toISOString(),
        },
      });

      // Only a real engine that inspected content can conclude infection, so
      // this cannot fire from the MVP stub. The guard is explicit rather than
      // implied by the stub's behaviour, because the stub is replaceable and
      // this rule is not.
      if (scan.verdict === 'INFECTED' && this.scanner.inspectsContent && scan.signature) {
        await this.events.enqueue(tx, {
          eventName: DOCUMENT_EVENTS.VIRUS_DETECTED,
          aggregateId: documentId,
          organizationId,
          payload: {
            documentId,
            organizationId,
            engine: scan.engine,
            engineVersion: scan.engineVersion,
            signature: scan.signature,
            detectedAt: scan.scannedAt.toISOString(),
          },
        });
      }

      return document;
    });

    documentsFinalizedTotal.inc({
      service: SERVICE_NAME,
      document_class: intent.documentClass,
      scan_state: scanStateOf(scan),
    });

    return toView(created, this.scanner);
  }

  // =========================================================================
  // 3. Reads
  // =========================================================================

  async get(documentId: string): Promise<DocumentView> {
    const document = await this.repository.findById(documentId);
    if (!document) throw RastaError.notFound('Document', documentId);

    assertDocumentReadable(document);
    return toView(document, this.scanner);
  }

  async list(
    query: ListDocumentsQuery,
  ): Promise<{ items: DocumentView[]; nextCursor: string | null }> {
    assertCanHandleDocuments();

    const rows = await this.repository.list(getOrganizationId(), query);
    const items = rows.slice(0, query.limit).map((row) => toView(row, this.scanner));
    const nextCursor = rows.length > query.limit ? (rows[query.limit - 1]?.id ?? null) : null;

    return { items, nextCursor };
  }

  // =========================================================================
  // 4. Download
  // =========================================================================

  /**
   * Issues a short-lived signed GET URL, if the document may be downloaded.
   *
   * The refusals are the point. A signed URL is a bearer credential for a
   * private object: once issued it works for anyone holding it, with no token
   * and no role. So the decision has to be made *before* signing, and it is
   * made by {@link canDownload}, which is a pure function precisely so it can
   * be enumerated in tests.
   */
  async createDownloadUrl(documentId: string): Promise<{
    downloadUrl: string;
    expiresInSeconds: number;
    filename: string;
    contentType: string;
  }> {
    const document = await this.repository.findById(documentId);
    if (!document) throw RastaError.notFound('Document', documentId);

    assertDocumentReadable(document);

    // No policy argument, and no configuration reaches this call. Only a
    // `CLEAN` verdict authorizes a download (ADR-014); with the MVP stub
    // recording `NOT_SCANNED`, that means an MVP deployment refuses every
    // download until a real scanner is bound behind `MALWARE_SCANNER` (Q-18).
    const decision = canDownload(document);

    if (!decision.allowed) {
      downloadUrlsRefusedTotal.inc({ service: SERVICE_NAME, reason: decision.reason });
      throw refusalError(decision);
    }

    const downloadUrl = await this.timeStorage('createDownloadUrl', () =>
      this.storage.createDownloadUrl({
        objectKey: document.objectKey,
        expiresInSeconds: this.env.DOCUMENT_SIGNED_URL_TTL_SECONDS,
        downloadFilename: document.filename,
        contentType: document.contentType,
      }),
    );

    downloadUrlsIssuedTotal.inc({
      service: SERVICE_NAME,
      document_class: document.documentClass,
    });

    return {
      downloadUrl,
      expiresInSeconds: this.env.DOCUMENT_SIGNED_URL_TTL_SECONDS,
      filename: document.filename,
      contentType: document.contentType,
    };
  }

  // =========================================================================
  // 5. Deletion
  // =========================================================================

  /**
   * Records a deletion and removes the object.
   *
   * A tombstone, not a row removal: "who deleted this, when, and why" has no
   * answer if the row is gone, and that question is the whole reason
   * audit evidence exists (AGENTS.md S-06).
   *
   * Idempotent by design. Deleting an already-deleted document returns the
   * same tombstone rather than a 404 or a conflict — a client retrying a
   * request whose response it lost is asking for the same end state, and it
   * already holds.
   */
  async remove(documentId: string, dto: DeleteDocumentDto): Promise<DocumentView> {
    const document = await this.repository.findById(documentId);
    if (!document) throw RastaError.notFound('Document', documentId);

    assertDocumentWritable(document);

    if (document.status === 'DELETED') {
      return toView(document, this.scanner);
    }

    const actor = getContext().userId ?? SERVICE_NAME;
    const deletedAt = new Date();

    const tombstoned = await this.prisma.transaction(async (tx) => {
      const updated = await this.repository.markDeleted(tx, document.id, {
        deletedAt,
        deletedBy: actor,
        reason: dto.reason,
        expectedVersion: document.version,
      });

      await this.events.enqueue(tx, {
        eventName: DOCUMENT_EVENTS.DOCUMENT_DELETED,
        aggregateId: document.id,
        organizationId: document.organizationId,
        payload: {
          documentId: document.id,
          organizationId: document.organizationId,
          documentClass: document.documentClass,
          reason: dto.reason,
          deletedBy: actor,
          deletedAt: deletedAt.toISOString(),
        },
      });

      return updated;
    });

    // After the tombstone commits, never before. If this fails the row still
    // says deleted and the document is already undownloadable; an orphaned
    // object is a cleanup problem, whereas a removed object with a live row
    // would be a document that exists and cannot be fetched.
    await this.timeStorage('remove', () => this.storage.remove(document.objectKey)).catch(
      () => undefined,
    );

    documentsDeletedTotal.inc({
      service: SERVICE_NAME,
      document_class: document.documentClass,
    });

    return toView(tombstoned, this.scanner);
  }

  // =========================================================================
  // Internals
  // =========================================================================

  /** Times a storage call, so latency and failure are visible per operation. */
  private async timeStorage<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    try {
      return await fn();
    } finally {
      storageOperationSeconds.observe(
        { service: SERVICE_NAME, operation },
        (Date.now() - startedAt) / 1000,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface DocumentView {
  id: string;
  organizationId: string;
  documentClass: string;
  status: string;
  contentType: string;
  sizeBytes: number;
  filename: string;
  scanState: string;
  /**
   * Whether anything actually looked at the bytes.
   *
   * Reported rather than inferred from `scanState`, so an operator reading one
   * document can see that the platform's scanner is a stub without reading
   * configuration — the same disclosure principle ADR-024 applies to
   * simulated payments.
   */
  scanInspectedContent: boolean;
  scanEngine: string | null;
  scannedAt: string | null;
  ownerResourceType: string | null;
  ownerResourceId: string | null;
  createdAt: string;
  createdBy: string;
  deletedAt: string | null;
  deletionReason: string | null;
}

interface DocumentRow {
  id: string;
  organizationId: string;
  documentClass: string;
  status: string;
  contentType: string;
  sizeBytes: number;
  filename: string;
  scanState: string;
  scanEngine: string | null;
  scannedAt: Date | null;
  ownerResourceType: string | null;
  ownerResourceId: string | null;
  createdAt: Date;
  createdBy: string;
  deletedAt: Date | null;
  deletionReason: string | null;
}

/**
 * The shape a caller sees.
 *
 * Note what is missing: no object key, no bucket, no signed URL, no storage
 * endpoint. A caller who could read the key could try to reach the object
 * with credentials obtained elsewhere, bypassing every check above — so the
 * key never crosses the API boundary at all (AGENTS.md S-09).
 */
function toView(row: DocumentRow, scanner: MalwareScanner): DocumentView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    documentClass: row.documentClass,
    status: row.status,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    filename: row.filename,
    scanState: row.scanState,
    scanInspectedContent: scanner.inspectsContent && row.scanState !== 'PENDING',
    scanEngine: row.scanEngine,
    scannedAt: row.scannedAt?.toISOString() ?? null,
    ownerResourceType: row.ownerResourceType,
    ownerResourceId: row.ownerResourceId,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    deletionReason: row.deletionReason,
  };
}

function scanStateOf(scan: ScanResult): 'NOT_SCANNED' | 'CLEAN' | 'INFECTED' | 'FAILED' {
  return scan.verdict;
}

/**
 * Turns a refusal into the right status code.
 *
 * A deleted document is `404` — it is gone, and saying "you may not download
 * the deleted document" confirms it existed. An unsafe one is `422`: it
 * exists, the caller may see its metadata, and the refusal is a business rule
 * they can act on by waiting or replacing the file.
 */
function refusalError(decision: DownloadDecision & { allowed: false }): RastaError {
  if (decision.reason === 'DELETED') {
    return RastaError.notFound('Document', decision.documentId);
  }
  return RastaError.businessRule(decision.message, {
    documentId: decision.documentId,
    reason: decision.reason,
  });
}
