import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Which routes have answered a refusal with a closed reason (`details`) during one run of the
 * integration suites: every API harness appends them as it closes (`settleRefusals`), the global
 * setup empties the file before a run and the global teardown reads it back
 * (`refusal-coverage.teardown.ts`). Under `coverage/`, which is not committed.
 */
export const COVERAGE_FILE = join(__dirname, '..', 'coverage', 'refusal-routes.jsonl');

export function clearCoverage(): void {
  if (existsSync(COVERAGE_FILE)) rmSync(COVERAGE_FILE);
}

export function recordRoutes(keys: Iterable<string>): void {
  mkdirSync(dirname(COVERAGE_FILE), { recursive: true });
  for (const key of new Set(keys)) appendFileSync(COVERAGE_FILE, `${JSON.stringify({ key })}\n`);
}

export function routesSeen(): Set<string> {
  if (!existsSync(COVERAGE_FILE)) return new Set();
  return new Set(
    readFileSync(COVERAGE_FILE, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => (JSON.parse(line) as { key: string }).key),
  );
}
