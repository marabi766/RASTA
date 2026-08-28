import { Injectable, Logger } from '@nestjs/common';

/**
 * The boundary between maintenance and supplier-service.
 *
 * docs/04 § 4.7 states the rule plainly: "فقط تعمیرگاه واجد شرایط قابل انتخاب
 * است" — only a qualified workshop may be selected — and names
 * `supplier-service` as the REST dependency that answers it. That service does
 * not exist, so today nothing can verify a qualification.
 *
 * There are three ways to handle that and only one of them is honest:
 *
 *   Pretend to check.      Add a configuration flag defaulting to "off" and a
 *                          branch that never runs. The code then claims a
 *                          control it does not have.
 *   Invent the answer.     Decide here what qualifies a workshop. That is
 *                          inventing a business rule the product document does
 *                          not state (AGENTS.md § 9).
 *   Name the seam.         Put the question behind a port with one honest
 *                          implementation, so the gap is a class you can find
 *                          rather than a sentence in a document.
 *
 * This is the third. Referrals are accepted and the absence of verification is
 * recorded once per referral, at a level an operator sees. When
 * supplier-service arrives, a second implementation of this class is the whole
 * change on this side — the call site, the DTO and the stored reference all
 * stay as they are (ADR-029, docs/24 Q-25).
 */

export interface WorkshopReferral {
  workshopOrganizationId: string;
  /** The organization the machine belongs to — the one paying for the work. */
  organizationId: string;
  assetId: string;
}

export interface WorkshopVerdict {
  /** Whether the referral may proceed. */
  permitted: boolean;
  /**
   * Whether the workshop's qualification was actually checked.
   *
   * Separate from `permitted` on purpose. "Allowed because it is qualified"
   * and "allowed because nobody can tell" are different facts, and collapsing
   * them is how a missing control comes to look like a passing one.
   */
  verified: boolean;
  reason: string;
}

export abstract class WorkshopDirectory {
  abstract verify(referral: WorkshopReferral): Promise<WorkshopVerdict>;
}

/**
 * The implementation this platform runs today.
 *
 * Accepts every referral and says so. The organization id itself is still
 * validated by the DTO, and the referral is still tenant-scoped and audited
 * like any other write — what is missing is only the qualification check.
 */
@Injectable()
export class UnverifiedWorkshopDirectory extends WorkshopDirectory {
  private readonly logger = new Logger(UnverifiedWorkshopDirectory.name);

  async verify(referral: WorkshopReferral): Promise<WorkshopVerdict> {
    this.logger.warn(
      `Referring ${referral.assetId} to ${referral.workshopOrganizationId} without a ` +
        'qualification check — supplier-service is not deployed (docs/24 Q-25)',
    );

    return {
      permitted: true,
      verified: false,
      reason: 'supplier-service is not available; workshop qualification was not verified',
    };
  }
}
