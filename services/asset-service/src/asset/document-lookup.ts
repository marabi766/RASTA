import { z } from 'zod';
import { RastaError, tryGetContext, type InternalTokenService } from '@rasta/nest-common';
import { SERVICE_NAME } from '../config/env';

/**
 * Asks document-service who owns a document before a reference to it is stored
 * (EXP-002 slice 7, Codex r1 on #225).
 *
 * A reference stores a `documentId` and claims it in the dossier and in
 * `ASSET_DOCUMENT_ATTACHED`. Taken on trust, tenant A could attach a document id
 * it learned of from tenant B: the dossier would then show it as A's, and the
 * event would say so. Document reads stay tenant-scoped, so no content leaks —
 * but the claim is false, and it is the platform's, not the caller's.
 *
 * ## What is asked, and of whom
 *
 * `GET /v1/documents/{id}` — the endpoint document-service already opens to this
 * service (`@AllowService('asset-service')`) — with a fresh `SERVICE` internal
 * token minted for exactly document-service and **signed with the organization
 * that owns the machine**, which document-service compares with the document's
 * owner. A document of another organization answers `404` there, as a missing one
 * does. The organization is never a header.
 *
 * ## Fail closed
 *
 * Only a well-formed `200` about this document lets an attach go ahead. `404`
 * means "no such document for this organization". Anything else — transport
 * error, timeout, `401`, `403`, `5xx`, a body that does not parse, an answer
 * about another document — is unavailable, and unavailable never means "attach
 * it anyway". Nothing from a failure (URL, token, body, status) is put into the
 * error.
 */

export interface ResolvedDocument {
  readonly id: string;
  readonly organizationId: string;
  readonly status: 'REGISTERED' | 'DELETED';
  readonly ownerResourceType: string | null;
  readonly ownerResourceId: string | null;
}

export interface DocumentLookup {
  /**
   * The document as `organizationId` may see it, or `null` when it may not see
   * one by that id. Throws an upstream error when it cannot be told.
   */
  find(documentId: string, organizationId: string): Promise<ResolvedDocument | null>;
}

export const DOCUMENT_LOOKUP = Symbol('ASSET_DOCUMENT_LOOKUP');

const DOCUMENT_SERVICE = 'document-service';

/**
 * What a service built without a lookup gets: no attach. A missing dependency
 * must never read as "the document is theirs".
 */
export const UNCONFIGURED_DOCUMENT_LOOKUP: DocumentLookup = {
  find: async () => {
    throw RastaError.upstreamUnavailable(DOCUMENT_SERVICE);
  },
};

const answerSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  status: z.enum(['REGISTERED', 'DELETED']),
  ownerResourceType: z.string().nullable(),
  ownerResourceId: z.string().nullable(),
});

const platformErrorSchema = z.object({ code: z.string() });

/** Identifier characters only; anything else is not forwarded as a correlation id. */
const SAFE_CORRELATION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface DocumentLookupClientOptions {
  readonly baseUrl: string;
  /** `ASSET_DOCUMENT_LOOKUP_TIMEOUT_MS`: one exchange, body included. */
  readonly timeoutMs: number;
  readonly tokens: Pick<InternalTokenService, 'issue'>;
  /** Injection seam for tests. */
  readonly fetch?: typeof fetch;
}

export class DocumentLookupClient implements DocumentLookup {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: DocumentLookupClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async find(documentId: string, organizationId: string): Promise<ResolvedDocument | null> {
    const token = await this.options.tokens.issue(
      SERVICE_NAME,
      DOCUMENT_SERVICE,
      'SERVICE',
      organizationId,
    );
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-internal-token': token,
    };
    const context = tryGetContext();
    if (context && SAFE_CORRELATION_ID.test(context.correlationId)) {
      headers['x-correlation-id'] = context.correlationId;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    timer.unref?.();
    let status: number;
    let text: string;
    try {
      const response = await this.fetchImpl(
        `${this.options.baseUrl.replace(/\/+$/, '')}/v1/documents/${encodeURIComponent(documentId)}`,
        { method: 'GET', headers, signal: controller.signal },
      );
      status = response.status;
      // The body is read inside the deadline too, and an answer that arrives
      // after it is not taken, even from a transport that ignored the abort.
      text = await response.text();
      if (controller.signal.aborted) throw new Error('deadline passed');
    } catch {
      // No cause attached: a runtime's transport error can quote the URL.
      throw controller.signal.aborted
        ? RastaError.upstreamTimeout(DOCUMENT_SERVICE, this.options.timeoutMs)
        : RastaError.upstreamUnavailable(DOCUMENT_SERVICE);
    } finally {
      clearTimeout(timer);
    }

    const body = parseJson(text);
    if (status === 404) {
      // Only the service's own refusal counts: the platform error body. A proxy's
      // 404 proves nothing about this document.
      if (platformErrorSchema.safeParse(body).data?.code !== 'NOT_FOUND') {
        throw RastaError.upstreamUnavailable(DOCUMENT_SERVICE);
      }
      return null;
    }
    if (status !== 200) throw RastaError.upstreamUnavailable(DOCUMENT_SERVICE);

    const parsed = answerSchema.safeParse(body);
    // An answer about another document is not an answer.
    if (!parsed.success || parsed.data.id !== documentId) {
      throw RastaError.upstreamUnavailable(DOCUMENT_SERVICE);
    }
    return parsed.data;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
