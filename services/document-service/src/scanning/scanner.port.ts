/**
 * The malware-scanning boundary (ADR-014, Q-18).
 *
 * Q-18 — "ClamAV self-hosted or a cloud service?" — is **open**. No decision
 * has been made, so this file describes the shape of an answer without
 * pretending to be one.
 *
 * The whole point of the port is that answering Q-18 later is adding a class,
 * not editing the domain: `DocumentService` knows this interface and the
 * verdicts below, and nothing else about scanning.
 */

/**
 * What a scanner concluded.
 *
 * `NOT_SCANNED` is the honest verdict for the MVP stub and is a first-class
 * value rather than an absence, because "we did not look" and "we looked and
 * it was clean" must never be recorded the same way. A future reader — or an
 * auditor — has to be able to tell which documents were actually examined.
 */
export type ScanVerdict = 'NOT_SCANNED' | 'CLEAN' | 'INFECTED' | 'FAILED';

export interface ScanResult {
  readonly verdict: ScanVerdict;
  /** The engine that produced it, recorded on the row so the claim is attributable. */
  readonly engine: string;
  /** Engine version, where one exists. */
  readonly engineVersion: string | null;
  /**
   * The signature name for an infection.
   *
   * Present only for `INFECTED`, and never a free-text engine message: a
   * message can echo file content, and this value is stored, logged and
   * published.
   */
  readonly signature: string | null;
  readonly scannedAt: Date;
}

export interface MalwareScanner {
  /**
   * Whether this scanner actually inspects content.
   *
   * Part of the interface rather than a property of one implementation, for
   * the same reason `PaymentProvider.simulated` is (ADR-024): every caller,
   * every operator and every API response must be able to answer "was this
   * really scanned?" without knowing which implementation is bound.
   */
  readonly inspectsContent: boolean;
  readonly name: string;

  scan(input: { objectKey: string; sizeBytes: number; contentType: string }): Promise<ScanResult>;
}
