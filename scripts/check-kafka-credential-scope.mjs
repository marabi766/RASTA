#!/usr/bin/env node
/**
 * No service process is given a Kafka credential that is not its own
 * (RUN-006, reviews of #131). See check-kafka-credential-scope-lib.mjs.
 * Checks a developer's own `.env` too, when there is one.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkBootstrapExample,
  checkCiUp,
  checkCompose,
  checkEnvExample,
  checkLocalEnv,
  checkWorkflow,
} from './check-kafka-credential-scope-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const services = read('infrastructure/docker/kafka/principals.development.txt')
  .split('\n')
  .filter((line) => line.endsWith('-service'));

const problems = [
  ...checkEnvExample(read('.env.example'), services),
  ...checkBootstrapExample(read('infrastructure/docker/kafka/bootstrap.env.example')),
  ...checkWorkflow(read('.github/workflows/ci.yml')),
  ...checkCiUp(read('infrastructure/docker/kafka/ci-up.sh')),
  ...checkCompose(read('docker-compose.yml')),
  ...(existsSync(resolve(root, '.env')) ? checkLocalEnv(read('.env')) : []),
];
if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`kafka credential scope: ${problem}\n`);
  process.exit(1);
}
process.stdout.write(
  'kafka credential scope: no service is given a Kafka credential but its own\n',
);
