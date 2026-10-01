import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { RastaError, getContext } from '@rasta/nest-common';
import {
  MAX_CHAIN_LINKS,
  TenderEvidenceRepository,
  type ChainLink,
} from './tender-evidence.repository';
import { genesisReceipt } from './tender-evidence';

/** The only caller the chain read answers: the service that opens bids against it. */
export const TENDER_EVIDENCE_CALLER = 'construction-service';

export const tenderChainViewSchema = z
  .object({
    tenderId: z.string(),
    /** The genesis of this tender's chain: where an empty chain starts. */
    genesis: z.string(),
    /** The newest receipt as announced, or the genesis when none has been. */
    head: z.string(),
    links: z.array(
      z
        .object({
          seq: z.number().int(),
          bidId: z.string(),
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

export type TenderChainView = z.infer<typeof tenderChainViewSchema>;

/**
 * Refuses everything but construction-service acting platform-wide: not a person
 * with any role, not another service, not a token signed for a tenant. The second
 * layer behind `@AllowService`, and the only one against a user token.
 */
export function assertEvidenceCaller(): void {
  const context = getContext();
  if (
    context.authType !== 'SERVICE' ||
    context.callerService !== TENDER_EVIDENCE_CALLER ||
    context.organizationId !== undefined
  ) {
    throw RastaError.forbidden('This endpoint is reserved for construction-service');
  }
}

/**
 * A tender's receipt chain and its head, from the evidence audit-service holds
 * (ADR-066 § 2): what the opening of bids is checked against, because
 * construction-service cannot rewrite it. An unknown tender has an empty chain whose
 * head is the genesis — nothing was announced, which is itself the answer.
 */
@Injectable()
export class TenderEvidenceService {
  constructor(private readonly repository: TenderEvidenceRepository) {}

  async chainOf(tenderId: string): Promise<TenderChainView> {
    assertEvidenceCaller();

    const links = await this.repository.chainOf(tenderId);
    if (links.length > MAX_CHAIN_LINKS) {
      // Refused rather than cut: a truncated chain would be a wrong head.
      throw RastaError.internal('The tender chain is longer than this service will return');
    }
    const genesis = genesisReceipt(tenderId);
    return {
      tenderId,
      genesis,
      head: links.at(-1)?.receipt ?? genesis,
      links: links.map(toLinkView),
    };
  }
}

function toLinkView(link: ChainLink): TenderChainView['links'][number] {
  return {
    seq: link.seq,
    bidId: link.bidId,
    revision: link.revision,
    receivedAt: link.receivedAt.toISOString(),
    ciphertextSha256: link.ciphertextSha256,
    contentCommitment: link.contentCommitment,
    previousReceipt: link.previousReceipt,
    receipt: link.receipt,
  };
}
