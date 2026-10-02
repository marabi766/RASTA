import { Inject, Injectable, Logger } from '@nestjs/common';
import { InternalTokenService, RastaError, getContext } from '@rasta/nest-common';
import { z } from 'zod';
import { ENV } from '../tokens';
import { SERVICE_NAME, type ConstructionEnv } from '../config/env';
import { readCapped } from '../organization/organization-directory';
import { SealingError } from './sealing/errors';
import { genesisReceipt, verifyReceiptChain, type TrustedReceipts } from './sealing/sealing';

/** The service that holds the receipt chain outside this one's database. */
export const AUDIT_SERVICE = 'audit-service';

/** A chain of a few hundred links is a few hundred kilobytes; over this is not the contract. */
export const MAX_CHAIN_BYTES = 8 * 1024 * 1024;

const digest = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * What audit-service answers, as this service reads it: declared here (no
 * cross-service imports) and `.strict()`, so a field that is not in the contract
 * makes the answer unusable instead of being quietly kept.
 */
export const tenderChainSchema = z
  .object({
    tenderId: z.string().min(1).max(128),
    genesis: digest,
    head: digest,
    links: z.array(
      z
        .object({
          seq: z.number().int().positive(),
          bidId: z.string().min(1).max(128),
          revision: z.number().int().positive(),
          receivedAt: z.string().datetime(),
          ciphertextSha256: digest,
          contentCommitment: digest,
          previousReceipt: digest,
          receipt: digest,
        })
        .strict(),
    ),
  })
  .strict();

export type TenderChain = z.infer<typeof tenderChainSchema>;

/** The seam opening bids reads the head through; tests put a chain in directly. */
export interface TenderEvidenceSource {
  fetchChain(organizationId: string, tenderId: string): Promise<TenderChain>;
}

/**
 * Reads a tender's receipt chain and head from audit-service (ADR-066 § 2-3).
 *
 * **The head is read from here, never from this service's own tables.** Whoever can
 * rewrite a bid can rewrite `bid_receipt` and the head with it; audit-service holds
 * what was announced when each bid was made, in a database this service cannot
 * write. So the opening of bids (PR 8) takes the chain from this client, verifies the
 * stored receipts against the head it returns (`verifyReceiptChain`), and **fails
 * closed**: unreachable, a non-200, a malformed body, a chain for another tender, an
 * internally broken chain or a head that is not its newest link all refuse the
 * opening. There is no fallback to a local head.
 *
 * `GET {AUDIT_SERVICE_URL}/v1/internal/tender-evidence/{tenderId}/chain` with an
 * `X-Internal-Token` signed for audit-service **and for the tender owner's
 * organization** (ADR-035, ADR-061 § 4): audit-service scopes the lookup by that
 * organization and the tender, so a chain is only ever read for the tenant it belongs
 * to; it refuses every other caller and a token signed for no tenant.
 */
@Injectable()
export class TenderEvidenceClient implements TenderEvidenceSource {
  private readonly logger = new Logger(TenderEvidenceClient.name);

  constructor(
    @Inject(ENV) private readonly env: ConstructionEnv,
    private readonly tokens: InternalTokenService,
  ) {}

  /** `organizationId` is the tender **owner's**: the organization the bids are stored under. */
  async fetchChain(organizationId: string, tenderId: string): Promise<TenderChain> {
    const token = await this.tokens.issue(SERVICE_NAME, AUDIT_SERVICE, 'SERVICE', organizationId);
    const url =
      `${this.env.AUDIT_SERVICE_URL.replace(/\/+$/, '')}` +
      `/v1/internal/tender-evidence/${encodeURIComponent(tenderId)}/chain`;

    const timeoutMs = this.env.CONSTRUCTION_AUDIT_REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'x-internal-token': token,
          'x-correlation-id': safeCorrelationId(),
        },
        signal: controller.signal,
      });
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        this.logger.warn(`audit-service answered ${response.status} to the chain read`);
        throw RastaError.upstreamUnavailable(AUDIT_SERVICE);
      }
      const text = await readCapped(response, MAX_CHAIN_BYTES);
      if (text === null) throw RastaError.upstreamUnavailable(AUDIT_SERVICE);

      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      const parsed = tenderChainSchema.safeParse(body);
      // The shape, never the content, is logged. A chain for another tender is no answer.
      if (!parsed.success || parsed.data.tenderId !== tenderId) {
        this.logger.warn('audit-service answered a chain that is not the contract');
        throw RastaError.upstreamUnavailable(AUDIT_SERVICE);
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof RastaError) throw error;
      if (controller.signal.aborted) throw RastaError.upstreamTimeout(AUDIT_SERVICE, timeoutMs);
      throw RastaError.upstreamUnavailable(AUDIT_SERVICE, error);
    } finally {
      clearTimeout(timer);
    }
  }
}

function safeCorrelationId(): string {
  try {
    return getContext().correlationId;
  } catch {
    return `tender-evidence-${Date.now()}`;
  }
}

/**
 * The receipts opening bids is checked against, **from the evidence** audit-service
 * holds — links and head — after checking that the chain is sound: it starts at this
 * tender's genesis, every link follows from the one before it, and it ends at the head
 * named. Anything else is `RECEIPT_CHAIN_BROKEN` and nothing is opened. The stored
 * bids are then compared with *these* links (`openBid`), not with this service's own
 * `bid_receipt`, which whoever rewrote a bid could have rewritten with it.
 */
export function trustedReceiptsOf(chain: TenderChain): TrustedReceipts {
  const links = chain.links.map((link) => ({
    bidId: link.bidId,
    revision: link.revision,
    receivedAt: new Date(link.receivedAt),
    ciphertextSha256: link.ciphertextSha256,
    contentCommitment: link.contentCommitment,
    receipt: link.receipt,
  }));
  const sound =
    chain.genesis === genesisReceipt(chain.tenderId) &&
    verifyReceiptChain(chain.tenderId, links, chain.head).ok;
  if (!sound) throw new SealingError('RECEIPT_CHAIN_BROKEN');
  return { links, head: chain.head };
}
