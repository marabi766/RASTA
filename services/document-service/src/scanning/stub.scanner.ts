import { Injectable } from '@nestjs/common';
import type { MalwareScanner, ScanResult } from './scanner.port';

/**
 * The MVP scanner, which does not scan.
 *
 * ## What this is, stated plainly
 *
 * It inspects nothing. It opens no file, loads no signature database and
 * contacts no service. It records that a document was **not** examined, and
 * that is the entire behaviour.
 *
 * Q-18 is open (`docs/24`): the platform has not chosen between self-hosted
 * ClamAV and a cloud scanner, and ADR-014 says the MVP carries a stub "که
 * نتیجه را ثبت می‌کند". A stub that returned `CLEAN` would satisfy that
 * sentence literally and lie in substance — every document would carry a clean
 * bill of health nobody issued, and the day a real scanner is wired in, the
 * backlog of "already clean" documents would never be re-examined.
 *
 * So the verdict is `NOT_SCANNED`, the engine is named for what it is, and
 * `inspectsContent` is `false`. Nothing downstream can mistake this for a
 * scan: `DocumentService` refuses downloads for anything that is not `CLEAN`,
 * which means **every document in an MVP deployment is undownloadable until a
 * real scanner exists**. That is the correct and deliberate consequence, and
 * it is far better than the alternative of serving unexamined bytes while a
 * status column says they were checked.
 *
 * ## What must not be done to this class
 *
 * It must not be made to return `CLEAN` to unblock a demo. If a demo needs a
 * downloadable document, the answer is a real scanner behind
 * {@link MalwareScanner}, or an explicit, configured, documented decision to
 * accept unscanned downloads in that environment — not a stub that
 * misreports.
 */
@Injectable()
export class NoOpMalwareScanner implements MalwareScanner {
  /**
   * `false`, and load-bearing.
   *
   * The API reports this so an operator can see, without reading
   * configuration, that nothing has been examined (ADR-024's disclosure
   * principle applied to scanning).
   */
  readonly inspectsContent = false;

  /**
   * Named for what it is.
   *
   * Not "clamav", not "scanner", not "default". The value is written to the
   * database, published on events and returned by the API, so a search for
   * which documents were checked by a real engine has to be able to exclude
   * these unambiguously.
   */
  readonly name = 'no-op-stub';

  async scan(): Promise<ScanResult> {
    return {
      verdict: 'NOT_SCANNED',
      engine: this.name,
      engineVersion: null,
      signature: null,
      scannedAt: new Date(),
    };
  }
}
