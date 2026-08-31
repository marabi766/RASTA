import type { MalwareScanner, ScanResult } from '../src/scanning/scanner.port';

/**
 * A scanner that reports `CLEAN`, for tests only.
 *
 * ## Why this exists
 *
 * `canDownload` allows exactly one state — `CLEAN` — and the production MVP
 * scanner records `NOT_SCANNED` because nothing has been chosen for Q-18 yet.
 * Those two facts together mean the download path is unreachable in the real
 * application, and an unreachable path is an untested one: the signed GET URL,
 * the attachment disposition, the byte-for-byte round trip and the metrics
 * would all sit at zero coverage with nothing but the refusal proven.
 *
 * So the tests that need a successful download inject this through the same
 * `MALWARE_SCANNER` port a real engine will use one day. Nothing about the
 * domain is substituted: the database, the bucket, the signed URLs, the policy
 * function and the controller are all real, and the only thing replaced is the
 * boundary that has no implementation yet.
 *
 * ## Why it lives in `test/`
 *
 * Because `tsconfig.json` excludes `test/**` from the build and sets
 * `rootDir` to `src`, so this file cannot be reached from production
 * composition even by accident — the compiler refuses before a reviewer has
 * to notice. It is bound only where a test binds it, never in `AppModule`.
 *
 * ## What it must never become
 *
 * A convenience for making downloads work. If it ever appears in
 * `src/`, in `AppModule`, or behind an environment variable, the platform is
 * serving unexamined bytes while a status column says they were checked —
 * which is precisely what ADR-014 forbids and what removing
 * `DOCUMENT_ALLOW_UNSCANNED_DOWNLOAD` was meant to prevent.
 */
export class AlwaysCleanScanner implements MalwareScanner {
  /**
   * `true`, because within the fiction of the test this scanner *did* look.
   *
   * Reporting `false` here would be the wrong lie in the other direction: the
   * view's `scanInspectedContent` would then say "nothing examined this" about
   * a document the suite is treating as examined, and the disclosure field
   * would stop meaning anything.
   */
  readonly inspectsContent = true;

  /** Named so that a row it produced is unmistakable in any database dump. */
  readonly name = 'test-only-clean-scanner';

  async scan(): Promise<ScanResult> {
    return {
      verdict: 'CLEAN',
      engine: this.name,
      engineVersion: 'test',
      signature: null,
      scannedAt: new Date(),
    };
  }
}
