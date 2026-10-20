/**
 * Quiets Nest's logger during tests.
 *
 * Every deliberate crossing of the tenant boundary is logged with its written
 * reason — the audit trail ADR-011 asks for, and exactly what an auditor
 * should be able to enumerate. In an integration run there are several hundred
 * of them, and they bury the assertion that actually failed.
 *
 * Set `VERBOSE_TEST_LOGS=1` to see them, which is what to do when diagnosing a
 * scoping problem.
 */
if (!process.env.VERBOSE_TEST_LOGS) {
  const { Logger } = require('@nestjs/common');
  Logger.overrideLogger(false);
}
