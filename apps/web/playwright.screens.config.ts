import base from './playwright.config';

/**
 * Screenshot capture.
 *
 * The main config excludes `@screenshot` tests by tag, because capture has no
 * assertions and a green tick against it would mean nothing. `--grep` and
 * `grepInvert` combine rather than override, so opting back in needs its own
 * config rather than a CLI flag.
 *
 * Everything else — viewports, base URL, the web server — is inherited, so the
 * screenshots are taken against exactly the build the tests ran against.
 */
export default {
  ...base,
  grepInvert: undefined,
  grep: /@screenshot/,
};
