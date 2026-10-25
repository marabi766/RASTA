/**
 * Fails if the CI "Unit tests" step runs the workspace's jest suites with
 * turbo's default concurrency (10 package tasks at once, each with its own
 * jest worker pool) instead of a bounded one.
 *
 *   node scripts/check-unit-step-concurrency.mjs   (the command-line wrapper)
 *
 * Why it is a gate: on the 4-vCPU runner, 10 packages x 3 workers made
 * apps/web's axe specs take ~8x their solo time, and a test over jest's 5 s
 * default failed the job (TASK 239; eleven web specs carry `jest.setTimeout(20_000)`
 * as symptom relief). Static: reads `.github/workflows/ci.yml` only.
 */
import { parse as parseYaml } from 'yaml';

export const UNIT_JOB = 'quality';
export const UNIT_STEP = 'Unit tests';
/** Package tasks at once; the runner has 4 vCPU and each jest uses cpus - 1 = 3 workers. */
export const MAX_CONCURRENCY = 3;
const COMMAND = /^pnpm run test:unit --concurrency=(\d+)$/;

/** Problems with the unit step in a workflow's text; empty when it is bounded. */
export function unitStepProblems(workflowText) {
  const steps = parseYaml(workflowText)?.jobs?.[UNIT_JOB]?.steps;
  if (!Array.isArray(steps)) return [`job "${UNIT_JOB}" has no steps`];
  const found = steps.filter((step) => step?.name === UNIT_STEP);
  if (found.length !== 1) {
    return [`job "${UNIT_JOB}" must have exactly one "${UNIT_STEP}" step, found ${found.length}`];
  }
  const run = typeof found[0].run === 'string' ? found[0].run.trim() : '';
  const match = COMMAND.exec(run);
  if (!match) {
    return [
      `"${UNIT_STEP}" must run \`pnpm run test:unit --concurrency=<1-${MAX_CONCURRENCY}>\` ` +
        `(turbo's default of 10 oversubscribes the runner); it runs ${JSON.stringify(run)}`,
    ];
  }
  const concurrency = Number(match[1]);
  if (concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    return [`"${UNIT_STEP}" concurrency ${concurrency} is outside 1..${MAX_CONCURRENCY}`];
  }
  return [];
}
