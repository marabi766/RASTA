/**
 * Quiets Nest's own logger during tests, so a failed assertion is the loudest
 * thing in the output rather than bootstrap noise.
 *
 * Set `VERBOSE_TEST_LOGS=1` to see it again.
 */
if (!process.env.VERBOSE_TEST_LOGS) {
  const { Logger } = require('@nestjs/common');
  Logger.overrideLogger(false);
}
