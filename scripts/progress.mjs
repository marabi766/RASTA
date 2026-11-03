import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { renderProgressReport, validateBacklog } from './progress-lib.mjs';
import { validateBacklogSchema } from './progress-schema.mjs';

const root = process.cwd();
const backlogPath = path.join(root, 'planning', 'backlog.json');
const schemaPath = path.join(root, 'planning', 'backlog.schema.json');
const reportPath = path.join(root, 'docs', '25-project-progress.md');
const command = process.argv[2] ?? 'validate';

async function load(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

const backlog = await load(backlogPath);
const errors = [
  ...validateBacklogSchema(backlog, await load(schemaPath)),
  ...validateBacklog(backlog),
];
if (errors.length > 0) {
  fail(`Backlog validation failed (${errors.length}):\n- ${errors.join('\n- ')}`);
} else if (command === 'validate') {
  process.stdout.write(
    `Backlog valid: ${backlog.items.length} features, ${backlog.stories.length} stories, ${backlog.epics.length} epics.\n`,
  );
} else if (command === 'write') {
  await writeFile(reportPath, renderProgressReport(backlog), 'utf8');
  process.stdout.write(`Wrote ${path.relative(root, reportPath)}.\n`);
} else if (command === 'check') {
  const expected = renderProgressReport(backlog);
  const actual = await readFile(reportPath, 'utf8').catch(() => '');
  if (actual !== expected)
    fail(`Generated progress report is stale. Run 'pnpm progress:report' and commit the result.`);
  else process.stdout.write('Backlog valid and generated progress report is current.\n');
} else {
  fail('Unknown command; it is not repeated. Use validate, write or check.');
}
