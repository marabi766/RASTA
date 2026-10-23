import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const cli = new URL('./backup-restore-drill.mjs', import.meta.url);

test('early mkdtemp failure writes a nonempty failure report', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-early-test-'));
  try {
    const report = join(directory, 'report.json');
    const child = spawn(process.execPath, [cli.pathname, '--report', report], {
      env: { ...process.env, TMPDIR: join(directory, 'missing') },
      stdio: 'ignore',
    });
    const [code] = await once(child, 'exit');
    assert.equal(code, 1);
    const evidence = JSON.parse(readFileSync(report, 'utf8'));
    assert.equal(evidence.passed, false);
    assert.equal(evidence.error.stage, 'preflight');
    assert.equal(evidence.cleanup.passed, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SIGHUP stops setup and cleans up with pinned Docker context and host', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-signal-test-'));
  let child;
  try {
    const report = join(directory, 'report.json');
    const started = join(directory, 'started');
    const cleaned = join(directory, 'cleaned');
    writeFileSync(join(directory, 'pnpm'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    writeFileSync(
      join(directory, 'docker'),
      `#!/bin/sh
[ "$DOCKER_CONTEXT" = default ] && [ "$DOCKER_HOST" = unix:///var/run/docker.sock ] || exit 99
case "$*" in
  *'up -d'*) touch '${started}'; exec sleep 30 ;;
  *'down --volumes'*) touch '${cleaned}' ;;
esac
`,
      { mode: 0o700 },
    );
    child = spawn(process.execPath, [cli.pathname, '--report', report], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        TMPDIR: directory,
        DOCKER_CONTEXT: 'remote',
        DOCKER_HOST: 'ssh://unwanted',
      },
      stdio: 'ignore',
    });
    const exit = once(child, 'exit');
    for (let attempt = 0; attempt < 200 && !existsSync(started); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(existsSync(started), 'setup started');
    child.kill('SIGHUP');
    const [code] = await exit;
    assert.equal(code, 1);
    const evidence = JSON.parse(readFileSync(report, 'utf8'));
    assert.equal(evidence.interrupted, true);
    assert.equal(evidence.cleanup.passed, true);
    assert.ok(existsSync(cleaned));
    assert.equal(
      readdirSync(directory).some((name) => name.startsWith('rasta-restore-drill-')),
      false,
    );
  } finally {
    child?.kill('SIGTERM');
    rmSync(directory, { recursive: true, force: true });
  }
});
