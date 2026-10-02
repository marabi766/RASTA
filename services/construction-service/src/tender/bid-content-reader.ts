import { Inject, Injectable, Logger } from '@nestjs/common';
import type { KeyObject } from 'node:crypto';
import { RastaError } from '@rasta/nest-common';
import type { Bid, TenderKey } from '../generated/prisma';
import { SERVICE_NAME } from '../config/env';
import { bidOpeningRefusalsTotal } from '../observability/metrics';
import { TENDER_EVIDENCE_SOURCE, TENDER_KEY_PROVIDER } from '../tokens';
import { bidContentSchema, type BidContent } from './bid.dto';
import { SealingError } from './sealing/errors';
import type { TenderKeyProvider } from './sealing/key-provider';
import {
  openBid,
  privateKeyFromDer,
  type SealedBid,
  type TrustedReceipts,
} from './sealing/sealing';
import {
  trustedReceiptsOf,
  type TenderChain,
  type TenderEvidenceSource,
} from './tender-evidence.client';

/** The evidence, read and checked: the chain as audit-service holds it, and the receipts made from it. */
export interface Evidence {
  chain: TenderChain;
  receipts: TrustedReceipts;
}

/** The integrity refusal, as the 422 the owner's routes and the contractor's own read both answer. */
export function integrityRefusal(): RastaError {
  return RastaError.businessRule('Bids are not opened: INTEGRITY', { refusals: ['INTEGRITY'] });
}

/**
 * Reading what a bid says (ADR-066 § 2-3), for everyone entitled to it after the opening: the
 * owner opening and reading the bids, and a contractor reading its own.
 *
 * The chain and its head are not this service's to say: they come from **audit-service** and are
 * checked to be sound; each bid is opened against **those** receipts. The tender's private key is
 * unwrapped only inside the call that needs it, held as a `KeyObject` for that call, and its DER
 * bytes are zeroised in a `finally`; it is never logged, never in an error, never kept. Nothing
 * here is stored in the clear anywhere: a read after the opening unwraps the key again.
 *
 * Who may read, and what each read leaves in the access log, is the caller's: this class only
 * turns sealed bytes into content, or refuses.
 */
@Injectable()
export class BidContentReader {
  private readonly logger = new Logger(BidContentReader.name);

  constructor(
    @Inject(TENDER_EVIDENCE_SOURCE) private readonly evidence: TenderEvidenceSource,
    @Inject(TENDER_KEY_PROVIDER) private readonly keys: TenderKeyProvider,
  ) {}

  /** The chain and head from audit-service, checked to be sound. Fails closed, always. */
  async readEvidence(ownerOrganizationId: string, tenderId: string): Promise<Evidence> {
    let chain: TenderChain;
    try {
      chain = await this.evidence.fetchChain(ownerOrganizationId, tenderId);
    } catch (error) {
      bidOpeningRefusalsTotal.inc({ service: SERVICE_NAME, reason: 'evidence_unavailable' });
      if (error instanceof RastaError) throw error;
      throw RastaError.upstreamUnavailable('audit-service', error);
    }
    try {
      return { chain, receipts: trustedReceiptsOf(chain) };
    } catch (error) {
      throw this.refusalOf(error);
    }
  }

  /**
   * Unwraps the tender's private key for the duration of `use` and no longer. `key` null means
   * the tender has none (a published tender always has).
   */
  withPrivateKey(
    key: TenderKey | null,
    tenderId: string,
    use: (privateKey: KeyObject, keyId: string) => void,
  ): void {
    if (!key) throw RastaError.internal('A published tender has no key; its bids cannot be opened');

    let der: Buffer | undefined;
    try {
      der = this.keys.unwrap(
        {
          kekId: key.kekId,
          nonce: Buffer.from(key.wrapNonce),
          ciphertext: Buffer.from(key.wrappedPrivateKey),
          tag: Buffer.from(key.wrapTag),
        },
        { tenderId, keyId: key.keyId },
      );
      use(privateKeyFromDer(der), key.keyId);
    } catch (error) {
      throw this.refusalOf(error);
    } finally {
      der?.fill(0);
    }
  }

  /** One bid, opened against the evidence's receipts and read as the content the bidder sealed. */
  openOne(
    privateKey: KeyObject,
    keyId: string,
    tenderId: string,
    bid: Bid,
    receipts: TrustedReceipts,
  ): BidContent {
    const sealed: SealedBid = {
      version: bid.sealVersion,
      keyId: bid.keyId,
      nonce: Buffer.from(bid.nonce),
      ciphertext: Buffer.from(bid.ciphertext),
      tag: Buffer.from(bid.tag),
      wrappedContentKey: Buffer.from(bid.wrappedContentKey),
      contentCommitment: bid.contentCommitment,
      ciphertextSha256: bid.ciphertextSha256,
    };
    const opened = openBid({
      privateKey,
      binding: {
        tenderId,
        bidId: bid.id,
        bidderOrganizationId: bid.bidderOrganizationId,
        revision: bid.revision,
        keyId,
      },
      sealed,
      receipts,
    });
    const content = bidContentSchema.safeParse(opened);
    // The commitment held, so this is what was sealed; a shape this service no longer reads is not a bid it can show.
    if (!content.success) throw new SealingError('TAMPERED');
    return content.data;
  }

  /** A sealing failure is an integrity refusal (or a missing key); nothing about which part failed is said. */
  refusalOf(error: unknown): unknown {
    if (!(error instanceof SealingError)) return error;
    if (error.code === 'KEY_UNAVAILABLE') {
      bidOpeningRefusalsTotal.inc({ service: SERVICE_NAME, reason: 'key_unavailable' });
      return RastaError.upstreamUnavailable('tender-key-provider');
    }
    bidOpeningRefusalsTotal.inc({ service: SERVICE_NAME, reason: 'integrity' });
    this.logger.error(`a bid did not verify against its receipt: ${error.code}`);
    return integrityRefusal();
  }
}
