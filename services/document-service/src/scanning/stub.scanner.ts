import { Injectable } from '@nestjs/common';
import type { MalwareScanner, ScanResult, ScannerHealth } from './scanner.port';

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
 * scan: `canDownload` allows `CLEAN` and nothing else, which means **every
 * document in an MVP deployment is undownloadable until a real scanner
 * exists**. That is the correct and deliberate consequence, and it is far
 * better than the alternative of serving unexamined bytes while a status
 * column says they were checked. Uploading and registering metadata still
 * work; only handing the bytes back waits.
 *
 * ## What must not be done to this class
 *
 * It must not be made to return `CLEAN` to unblock a demo, and no
 * configuration may be added that lets `NOT_SCANNED` through. There is no
 * environment variable for it and there must not be one: ADR-014 keeps a file
 * unavailable until scanning completes, and a flag that switches an invariant
 * off is a bypass however carefully it is documented. If product ownership
 * wants downloadable files before a scanner exists, that is an explicit
 * product and security decision recorded as an ADR amendment.
 *
 * The one legitimate substitution is a different implementation of
 * {@link MalwareScanner}: a real engine in production, and — in tests that
 * need to reach the download path — a test-only fake that returns `CLEAN`,
 * bound in the test's own composition and never in `AppModule`.
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
      signatureVersion: null,
      signatureAgeSeconds: null,
      signature: null,
      failureReason: null,
      retryable: false,
      scannedAt: new Date(),
    };
  }

  /**
   * Available, and honest about what that means.
   *
   * `available: true` because the stub cannot fail — there is nothing to
   * reach. It would be wrong to report it unavailable, which an operator would
   * read as an outage to fix rather than as the configuration they chose. What
   * `detail` says instead is what is actually true: this deployment inspects
   * nothing, so no document in it will ever become downloadable.
   *
   * `signaturesFresh` is `false`, and that is not pessimism. There is no
   * signature database, so there is nothing fresh about it, and the readiness
   * probe's freshness field must not be able to read as reassuring here.
   */
  async health(): Promise<ScannerHealth> {
    return {
      available: true,
      engine: this.name,
      engineVersion: null,
      signatureVersion: null,
      signatureAgeSeconds: null,
      signaturesFresh: false,
      detail: 'no content is inspected; every document stays undownloadable',
    };
  }
}
