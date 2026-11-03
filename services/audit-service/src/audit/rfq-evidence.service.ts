import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { RastaError, getContext } from '@rasta/nest-common';
import { MAX_CHAIN_LINKS, RfqEvidenceRepository, type ChainLink } from './rfq-evidence.repository';
import { genesisReceipt } from './rfq-evidence';

/** The only caller the chain read answers: the service that opens quotations against it. */
export const RFQ_EVIDENCE_CALLER = 'procurement-service';

export const rfqChainViewSchema = z
  .object({
    rfqId: z.string(),
    /** The genesis of this RFQ's chain: where an empty chain starts. */
    genesis: z.string(),
    /** The newest receipt as announced, or the genesis when none has been. */
    head: z.string(),
    links: z.array(
      z
        .object({
          seq: z.number().int(),
          quotationId: z.string(),
          revision: z.number().int(),
          receivedAt: z.string(),
          ciphertextSha256: z.string(),
          contentCommitment: z.string(),
          previousReceipt: z.string(),
          receipt: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

export type RfqChainView = z.infer<typeof rfqChainViewSchema>;

/**
 * Refuses everything but procurement-service acting **for a tenant** — the RFQ
 * owner's organization, signed into the token (ADR-035, ADR-061 § 4): not a person
 * with any role, not another service, not a platform-wide token. The second layer
 * behind `@AllowService`, and the only one against a user token. Returns the
 * organization the read is scoped to.
 */
export function assertRfqEvidenceCaller(): string {
  const context = getContext();
  if (
    context.authType !== 'SERVICE' ||
    context.callerService !== RFQ_EVIDENCE_CALLER ||
    context.organizationId === undefined
  ) {
    throw RastaError.forbidden(
      'This endpoint is reserved for procurement-service acting for a tenant',
    );
  }
  return context.organizationId;
}

/**
 * An RFQ's receipt chain and its head, from the evidence audit-service holds
 * (ADR-070 § 4, ADR-066 § 2): what the opening of quotations is checked against, because
 * procurement-service cannot rewrite it. The lookup is scoped by the token's
 * organization **and** the RFQ, so no organization can read another's chain. An
 * RFQ nothing was announced for (under that organization) has an empty chain whose
 * head is the genesis — nothing was announced, which is itself the answer.
 */
@Injectable()
export class RfqEvidenceService {
  constructor(private readonly repository: RfqEvidenceRepository) {}

  async chainOf(rfqId: string): Promise<RfqChainView> {
    const organizationId = assertRfqEvidenceCaller();

    const links = await this.repository.chainOf(organizationId, rfqId);
    if (links.length > MAX_CHAIN_LINKS) {
      // Refused rather than cut: a truncated chain would be a wrong head.
      throw RastaError.internal('The RFQ chain is longer than this service will return');
    }
    const genesis = genesisReceipt(rfqId);
    return {
      rfqId,
      genesis,
      head: links.at(-1)?.receipt ?? genesis,
      links: links.map(toLinkView),
    };
  }
}

function toLinkView(link: ChainLink): RfqChainView['links'][number] {
  return {
    seq: link.seq,
    quotationId: link.quotationId,
    revision: link.revision,
    receivedAt: link.receivedAt.toISOString(),
    ciphertextSha256: link.ciphertextSha256,
    contentCommitment: link.contentCommitment,
    previousReceipt: link.previousReceipt,
    receipt: link.receipt,
  };
}
