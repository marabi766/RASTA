/**
 * Teaches the test runner how to serialise a `bigint`.
 *
 * Jest runs each suite in a worker and sends results back to the parent with
 * `JSON.stringify`. A failed assertion carries the received and expected values
 * along with the message, so the moment a test involving money fails, the
 * worker throws `TypeError: Do not know how to serialize a BigInt` **instead of
 * reporting the failure** — the suite is listed as "failed to run" and the real
 * assertion is never shown.
 *
 * That matters more here than anywhere else on the platform: every amount in
 * this service is a `bigint` (ADR-022), so without this the first genuine
 * financial regression would arrive in CI as an unreadable serialisation error.
 * It cost one debugging cycle to find; this file is so it costs nobody else
 * one.
 *
 * Test-environment only, and the narrowest possible fix — `JSON.stringify`
 * consults `toJSON` when it exists, so nothing else about `bigint` changes.
 */
// eslint-disable-next-line no-extend-native, @typescript-eslint/no-unsafe-member-access
BigInt.prototype.toJSON = function toJSON() {
  return this.toString();
};

/**
 * Quiets Nest's logger during tests.
 *
 * Every deliberate crossing of the tenant boundary is logged with its written
 * reason — which is the audit trail ADR-011 asks for, and exactly what an
 * auditor should be able to enumerate. In an integration run there are several
 * hundred of them, and they bury the assertion that actually failed.
 *
 * Set `VERBOSE_TEST_LOGS=1` to see them, which is what to do when diagnosing a
 * scoping problem.
 */
if (!process.env.VERBOSE_TEST_LOGS) {
  const { Logger } = require('@nestjs/common');
  Logger.overrideLogger(false);
}
