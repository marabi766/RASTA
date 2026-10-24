import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const cli = new URL('./backup-restore-drill.mjs', import.meta.url);
const repo = new URL('..', import.meta.url).pathname;

function fixture(directory) {
  const root = join(directory, 'root');
  mkdirSync(root);
  for (const file of [
    'docker-compose.yml',
    '.env.migrator.example',
    'infrastructure/docker/postgres/lib/role-passwords.bash',
  ]) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    cpSync(join(repo, file), join(root, file));
  }
  // Copy only schema discovery inputs; never copy a developer's .env.
  for (const entry of readdirSync(join(repo, 'services'))) {
    const schema = join('services', entry, 'prisma/schema.prisma');
    if (existsSync(join(repo, schema))) {
      mkdirSync(join(root, schema, '..'), { recursive: true });
      cpSync(join(repo, schema), join(root, schema));
    }
  }
  return root;
}
async function waitFor(path) {
  for (let attempt = 0; attempt < 400 && !existsSync(path); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(existsSync(path), path);
}
function start(directory, root, extra = {}) {
  const child = spawn(
    process.execPath,
    [cli.pathname, '--report', join(directory, 'report.json')],
    {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        TMPDIR: directory,
        RASTA_DRILL_ROOT: root,
        DOCKER_CONTEXT: 'remote',
        DOCKER_HOST: 'ssh://unwanted',
        ...extra,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.resume();
  child.stderr.resume();
  return child;
}

test('early mkdtemp failure writes a nonempty failure report', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-early-test-'));
  try {
    const child = start(directory, fixture(directory), { TMPDIR: join(directory, 'missing') });
    const [code] = await once(child, 'exit');
    assert.equal(code, 1);
    const evidence = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8'));
    assert.equal(evidence.passed, false);
    assert.equal(evidence.error.stage, 'preflight');
    assert.equal(evidence.cleanup.passed, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('operator root with local .env still refuses before setup', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-env-test-'));
  try {
    const root = fixture(directory);
    writeFileSync(join(root, '.env'), 'SYNTHETIC_TEST=true\n');
    const child = start(directory, root);
    const [code] = await once(child, 'exit');
    assert.equal(code, 1);
    const evidence = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8'));
    assert.match(evidence.error.message, /Use a clean worktree without local env files/);
    assert.equal(evidence.databases.length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('schema coverage fails in both directions before any setup or fixture writes', async () => {
  for (const direction of ['missing', 'extra']) {
    const directory = mkdtempSync(join(tmpdir(), 'drill-coverage-cli-'));
    try {
      const root = fixture(directory);
      if (direction === 'missing') {
        mkdirSync(join(root, 'services/unlisted-service/prisma'), { recursive: true });
        writeFileSync(
          join(root, 'services/unlisted-service/prisma/schema.prisma'),
          'datasource db {}',
        );
      } else rmSync(join(root, 'services/economic-service'), { recursive: true });
      writeFileSync(join(directory, 'pnpm'), `#!/bin/sh\ntouch '${directory}/side-effect'\n`, {
        mode: 0o700,
      });
      writeFileSync(join(directory, 'docker'), `#!/bin/sh\ntouch '${directory}/side-effect'\n`, {
        mode: 0o700,
      });
      const [code] = await once(start(directory, root), 'exit');
      assert.equal(code, 1);
      const evidence = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8'));
      assert.match(evidence.error.message, /Service coverage mismatch/);
      // Resource enumeration is read-only and allowed after a refusal, but no commands are needed
      // until Compose has been written.
      assert.equal(existsSync(join(directory, 'side-effect')), false);
      assert.equal(
        readdirSync(directory).some((name) => name.startsWith('rasta-restore-drill-')),
        false,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

for (const stoppedLeftover of [false, true]) {
  test(`SIGHUP, second signal and broken stderr complete teardown; stopped leftover=${stoppedLeftover}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'drill-signal-test-'));
    let child;
    try {
      const root = fixture(directory);
      writeFileSync(join(directory, 'pnpm'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      writeFileSync(
        join(directory, 'docker'),
        `#!/bin/sh
[ "$DOCKER_CONTEXT" = default ] && [ "$DOCKER_HOST" = unix:///var/run/docker.sock ] || exit 99
case "$*" in
  *'up -d'*) touch '${directory}/started'; exec sleep 30 ;;
  *'down --volumes'*)
    touch '${directory}/cleaning'
    while [ ! -f '${directory}/release' ]; do sleep 0.05; done
    touch '${directory}/cleaned' ;;
  'container ls -a '*) ${stoppedLeftover ? 'echo stopped-owned-container' : ':'} ;;
esac
`,
        { mode: 0o700 },
      );
      child = start(directory, root);
      const exit = once(child, 'exit');
      await waitFor(join(directory, 'started'));
      child.kill('SIGHUP');
      await waitFor(join(directory, 'cleaning'));
      // Close the read end of a real pipe. The next signal writes to the broken pipe.
      child.stderr.destroy();
      child.kill('SIGINT');
      await new Promise((resolve) => setTimeout(resolve, 100));
      writeFileSync(join(directory, 'release'), 'go');
      const [code] = await exit;
      assert.equal(code, 1);
      const evidence = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8'));
      assert.equal(evidence.interrupted, true);
      assert.equal(evidence.passed, false);
      assert.deepEqual(evidence.signals, [
        { signal: 'SIGHUP', duringCleanup: false },
        { signal: 'SIGINT', duringCleanup: true },
      ]);
      assert.equal(evidence.cleanup.passed, !stoppedLeftover);
      assert.ok(existsSync(join(directory, 'cleaned')), 'blocked teardown completed');
      if (stoppedLeftover) assert.ok(evidence.cleanup.temporary);
      else
        assert.equal(
          readdirSync(directory).some((name) => name.startsWith('rasta-restore-drill-')),
          false,
        );
    } finally {
      child?.kill('SIGTERM');
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('bounded command diagnostics redact database URLs and retain synthetic stdout honestly', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'drill-diagnostic-test-'));
  try {
    const root = fixture(directory);
    writeFileSync(
      join(directory, 'pnpm'),
      '#!/bin/sh\nprintf "synthetic-demo-row\\n"\nprintf "postgresql://demo:example@127.0.0.1/disposable\\n" >&2\nexit 1\n',
      { mode: 0o700 },
    );
    writeFileSync(join(directory, 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const [code] = await once(start(directory, root), 'exit');
    assert.equal(code, 1);
    const evidence = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8'));
    assert.match(evidence.error.message, /synthetic-demo-row/);
    assert.match(evidence.error.message, /database URL redacted/);
    assert.doesNotMatch(evidence.error.message, /postgresql:|demo:example/);
    assert.equal(evidence.cleanup.passed, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
