import { REFUSAL_REASONS } from '../src/openapi/document';
import { routesSeen } from './refusal-coverage';

/**
 * After a **whole** run of the integration suites: every route of `REFUSAL_REASONS` has answered a
 * real refusal carrying its closed reason in `details` (docs/06 § 6.7), and each such answer was
 * checked against the generated OpenAPI document as its suite closed (`settleRefusals`). A route
 * added to the table with no suite that provokes it fails the run here, not in a client.
 *
 * Skipped when the run is not the whole one — a test-name filter, named files, changed or failed
 * tests only, a shard — because those cannot reach every route; `REFUSAL_COVERAGE_ENFORCE=1`
 * forces the check (to try it, or on a deliberate subset).
 */
export default function teardown(globalConfig: {
  testNamePattern?: string;
  nonFlagArgs?: string[];
  onlyChanged?: boolean;
  onlyFailures?: boolean;
  shard?: unknown;
}): void {
  const whole =
    !globalConfig.testNamePattern &&
    (globalConfig.nonFlagArgs ?? []).length === 0 &&
    !globalConfig.onlyChanged &&
    !globalConfig.onlyFailures &&
    !globalConfig.shard;
  if (!whole && process.env.REFUSAL_COVERAGE_ENFORCE !== '1') return;

  const seen = routesSeen();
  const missing = Object.keys(REFUSAL_REASONS).filter((key) => !seen.has(key));
  if (missing.length > 0) {
    throw new Error(
      `No integration suite provoked a refusal with a closed reason on: ${missing.join(', ')}. ` +
        'Every route of REFUSAL_REASONS needs one real refusal in a suite that boots the application (startApi).',
    );
  }
}
