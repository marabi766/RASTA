#!/usr/bin/env node
/**
 * Fails if identity's aggregation stress spec could run in the parallel test
 * phase, twice, or not at all — or if any services/* `test` script would need
 * a database, which would make `pnpm verify` require `pnpm infra:up`.
 *
 *   node scripts/check-test-phases.mjs
 *
 * Static: reads the root and identity `package.json`, `turbo.json`, identity's
 * jest config and file list, the spec's test titles and the CI workflow. No
 * database, no turbo, no jest run. The reasoning is in `test-phases-lib.mjs`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  EXCLUSIVE_PHASE,
  stripJsonComments,
  validateInfraFreeTestTask,
  validateTestPhases,
} from './test-phases-lib.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function listFiles(base, dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.'))
      return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(base, path) : [relative(base, path).replace(/\\/g, '/')];
  });
}

/** The real orchestration files, in the shape `validateTestPhases` takes. */
export function readTestPhaseInputs(root = repositoryRoot) {
  const packageDir = join(root, EXCLUSIVE_PHASE.packageDir);
  const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const identityPackage = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  const turbo = JSON.parse(stripJsonComments(readFileSync(join(root, 'turbo.json'), 'utf8')));
  const jestConfig = createRequire(import.meta.url)(join(packageDir, 'jest.config.js'));
  const servicesDir = join(root, 'services');
  const serviceScripts = Object.fromEntries(
    readdirSync(servicesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => [
        `services/${entry.name}`,
        JSON.parse(readFileSync(join(servicesDir, entry.name, 'package.json'), 'utf8')).scripts,
      ]),
  );
  return {
    serviceScripts,
    rootScripts: rootPackage.scripts,
    turboTasks: turbo.tasks,
    identityScripts: identityPackage.scripts,
    jestProjects: jestConfig.projects ?? [],
    identityFiles: ['src', 'test'].flatMap((dir) => listFiles(packageDir, join(packageDir, dir))),
    specSource: readFileSync(join(packageDir, EXCLUSIVE_PHASE.spec), 'utf8'),
    ciWorkflow: readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8'),
  };
}

function main() {
  let problems;
  try {
    const inputs = readTestPhaseInputs();
    problems = [...validateInfraFreeTestTask(inputs.serviceScripts), ...validateTestPhases(inputs)];
  } catch (error) {
    console.error(
      `test phases: cannot read the orchestration files — refusing to pass (${error.message})`,
    );
    process.exit(1);
  }

  if (problems.length > 0) {
    console.error(`test phases: ${problems.length} problem(s).\n`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }

  console.warn(
    `test phases: ${EXCLUSIVE_PHASE.packageDir}/${EXCLUSIVE_PHASE.spec} runs once, alone, after the workspace phase ` +
      '(pnpm test:integration and CI, never pnpm test); every services/* "test" selects the unit project only, ' +
      'so pnpm test and pnpm verify need no database',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
