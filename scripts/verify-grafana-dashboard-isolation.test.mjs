import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROBE_ENV,
  createInternalNetwork,
  inspectInternalNetwork,
  inspectIsolatedContainers,
  isolationEvidence,
  publishedBindings,
  readProbeEnvironment,
} from './verify-grafana-dashboard-isolation-lib.mjs';
import { verifyLive } from './verify-grafana-dashboard-live.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NET = 'rasta-dashcheck-test-000000';
const CONTAINERS = [`${NET}-prometheus`, `${NET}-grafana`, `${NET}-probe`];

const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const failed = (stderr) => ({ status: 1, stdout: '', stderr });

/** A fake Docker CLI: `respond(args)` returns a result or undefined for a plain success. Records every call. */
function fakeDocker(respond = () => undefined) {
  const calls = [];
  const docker = (args, options = {}) => {
    calls.push({ args, options });
    const result = respond(args) ?? ok();
    if (result.status !== 0 && !options.allowFailure) {
      throw new Error(`docker ${args[0]} failed (${result.status}): ${result.stderr}`);
    }
    return result;
  };
  return { docker, calls };
}

const networkJson = (overrides = {}) => [{ Name: NET, Id: 'abc', Internal: true, ...overrides }];

function containerJson(name, overrides = {}) {
  return {
    Name: `/${name}`,
    State: { Status: 'running', Running: true, ExitCode: 0 },
    HostConfig: { NetworkMode: NET, PortBindings: {}, PublishAllPorts: false },
    NetworkSettings: { Networks: { [NET]: {} }, Ports: { '9090/tcp': null } },
    Mounts: [
      { Type: 'volume', Name: `${name}-anon` },
      { Type: 'bind', Source: '/repo' },
    ],
    ...overrides,
  };
}

const inspectReturning = (json) => (args) =>
  args[0] === 'network' || args[0] === 'container' ? ok(JSON.stringify(json)) : undefined;

test('creates the exact network with --internal, then inspects it', () => {
  const { docker, calls } = fakeDocker(inspectReturning(networkJson()));
  const network = createInternalNetwork(docker, NET);
  assert.deepEqual(calls[0].args, ['network', 'create', '--internal', NET]);
  assert.deepEqual(calls[1].args, ['network', 'inspect', NET]);
  assert.deepEqual(network, { name: NET, internal: true });
});

test('a failed network create fails before any inspection', () => {
  const { docker, calls } = fakeDocker((args) =>
    args[1] === 'create' ? failed('denied') : undefined,
  );
  assert.throws(
    () => createInternalNetwork(docker, NET),
    /network create --internal .* failed \(1\): denied/,
  );
  assert.equal(calls.length, 1);
});

test('accepts exactly one inspected network with Internal boolean true', () => {
  const { docker } = fakeDocker(inspectReturning(networkJson()));
  assert.deepEqual(inspectInternalNetwork(docker, NET), { name: NET, internal: true });
});

test('network inspection fails closed', () => {
  const cases = [
    [
      'Internal false',
      () => ok(JSON.stringify(networkJson({ Internal: false }))),
      /not internal \(Internal=false\)/,
    ],
    [
      'Internal string "true"',
      () => ok(JSON.stringify(networkJson({ Internal: 'true' }))),
      /not internal \(Internal="true"\)/,
    ],
    [
      'Internal missing',
      () => ok(JSON.stringify([{ Name: NET }])),
      /not internal \(Internal=undefined\)/,
    ],
    ['empty output', () => ok(''), /did not return JSON/],
    ['malformed output', () => ok('[{"Name": '), /did not return JSON/],
    ['empty array', () => ok('[]'), /returned no objects/],
    ['an object, not an array', () => ok(JSON.stringify(networkJson()[0])), /returned no objects/],
    [
      'two networks',
      () => ok(JSON.stringify([...networkJson(), ...networkJson()])),
      /expected 1 inspected network, got 2/,
    ],
    [
      'wrong name',
      () => ok(JSON.stringify(networkJson({ Name: 'bridge' }))),
      /inspection returned network "bridge"/,
    ],
    [
      'inspect command fails',
      () => failed('No such network'),
      /network inspect .* failed \(1\): No such network/,
    ],
  ];
  for (const [label, respond, pattern] of cases) {
    const { docker } = fakeDocker((args) => (args[0] === 'network' ? respond() : undefined));
    assert.throws(() => inspectInternalNetwork(docker, NET), pattern, label);
  }
  const throwing = () => {
    throw new Error('docker could not start');
  };
  assert.throws(() => inspectInternalNetwork(throwing, NET), /could not start/);
});

test('accepts three containers attached only to the network with no host binding', () => {
  const json = CONTAINERS.map((name) => containerJson(name));
  json[1].NetworkSettings.Ports = { '3000/tcp': [] };
  json[2].NetworkSettings.Ports = {};
  json[2].HostConfig.PortBindings = null;
  const { docker, calls } = fakeDocker(inspectReturning(json));
  const result = inspectIsolatedContainers(docker, NET, CONTAINERS);
  assert.deepEqual(calls[0].args, ['container', 'inspect', ...CONTAINERS]);
  assert.deepEqual(
    result.map((c) => [c.name, c.volumes]),
    CONTAINERS.map((name) => [name, [`${name}-anon`]]),
  );
  assert.equal(
    isolationEvidence({ name: NET, internal: true }, result),
    `network ${NET} internal=true; 3 containers attached only to it (${CONTAINERS.join(', ')}); publishedPorts=0`,
  );
});

test('container inspection fails closed on network drift or a published port', () => {
  const mutate = (index, change) => {
    const json = CONTAINERS.map((name) => containerJson(name));
    change(json[index]);
    return json;
  };
  const cases = [
    [
      'extra network',
      mutate(1, (c) => (c.NetworkSettings.Networks.bridge = {})),
      /grafana is attached to \[.*, bridge\], expected only/,
    ],
    [
      'wrong network',
      mutate(0, (c) => (c.NetworkSettings.Networks = { bridge: {} })),
      /prometheus is attached to \[bridge\]/,
    ],
    [
      'no network',
      mutate(2, (c) => (c.NetworkSettings.Networks = {})),
      /probe is attached to \[\]/,
    ],
    [
      'networks missing',
      mutate(2, (c) => delete c.NetworkSettings.Networks),
      /probe is attached to \[\]/,
    ],
    [
      'host network mode',
      mutate(0, (c) => (c.HostConfig.NetworkMode = 'host')),
      /network mode is "host"/,
    ],
    [
      'published dynamic port',
      mutate(
        1,
        (c) =>
          (c.NetworkSettings.Ports = { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '55001' }] }),
      ),
      /grafana publishes host ports: NetworkSettings\.Ports 3000\/tcp -> 127\.0\.0\.1:55001/,
    ],
    [
      'requested binding',
      mutate(
        0,
        (c) =>
          (c.HostConfig.PortBindings = { '9090/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] }),
      ),
      /prometheus publishes host ports: HostConfig\.PortBindings 9090\/tcp/,
    ],
    [
      'publish all',
      mutate(2, (c) => (c.HostConfig.PublishAllPorts = true)),
      /probe publishes host ports: HostConfig\.PublishAllPorts/,
    ],
    [
      'malformed ports',
      mutate(1, (c) => (c.NetworkSettings.Ports = { '3000/tcp': 'yes' })),
      /Ports 3000\/tcp is malformed/,
    ],
    [
      'missing container',
      CONTAINERS.slice(0, 2).map((name) => containerJson(name)),
      /expected 3 inspected containers, got 2/,
    ],
    [
      'duplicated container',
      [containerJson(CONTAINERS[0]), containerJson(CONTAINERS[0]), containerJson(CONTAINERS[2])],
      /prometheus: expected 1 inspection result, got 2/,
    ],
  ];
  for (const [label, json, pattern] of cases) {
    const { docker } = fakeDocker(inspectReturning(json));
    assert.throws(() => inspectIsolatedContainers(docker, NET, CONTAINERS), pattern, label);
  }
  const { docker } = fakeDocker(() => failed('No such container'));
  assert.throws(
    () => inspectIsolatedContainers(docker, NET, CONTAINERS),
    /container inspect .* failed \(1\)/,
  );
  assert.deepEqual(publishedBindings({ HostConfig: { PortBindings: { '80/tcp': null } } }), []);
});

test('the probe accepts only plain alias URLs and a password it never echoes', () => {
  const password = 'f'.repeat(36);
  const env = {
    [PROBE_ENV.prometheusUrl]: 'http://prometheus:9090',
    [PROBE_ENV.grafanaUrl]: 'http://grafana:3000',
    [PROBE_ENV.grafanaPassword]: password,
  };
  assert.deepEqual(readProbeEnvironment(env), {
    prometheus: 'http://prometheus:9090',
    grafana: 'http://grafana:3000',
    password,
  });
  const rejected = [
    [PROBE_ENV.prometheusUrl, undefined, /RASTA_DASHCHECK_PROMETHEUS_URL is required/],
    [PROBE_ENV.grafanaUrl, 'not a url', /RASTA_DASHCHECK_GRAFANA_URL is not a URL/],
    [PROBE_ENV.grafanaUrl, 'https://grafana:3000', /must be http:\/\/<container alias>:<port>/],
    [PROBE_ENV.grafanaUrl, 'http://127.0.0.1:3000', /must be http/],
    [PROBE_ENV.grafanaUrl, 'http://grafana.example.com:3000', /must be http/],
    [PROBE_ENV.grafanaUrl, 'http://grafana', /must be http/],
    [PROBE_ENV.grafanaUrl, 'http://admin:x@grafana:3000', /must be http/],
    [PROBE_ENV.prometheusUrl, 'http://prometheus:9090/api', /must be http/],
    [PROBE_ENV.grafanaPassword, undefined, /RASTA_DASHCHECK_GRAFANA_PASSWORD is required/],
    [PROBE_ENV.grafanaPassword, 'short', /at least 16 characters/],
  ];
  for (const [key, value, pattern] of rejected) {
    assert.throws(
      () => readProbeEnvironment({ ...env, [key]: value }),
      (error) => pattern.test(error.message) && !error.message.includes(password),
      `${key}=${value}`,
    );
  }
});

/** A fake Docker that behaves like a healthy isolated run, with optional per-call overrides. */
function liveDocker({ networkInspections = [], containerInspections = [], probeExit = 0 } = {}) {
  let networkInspect = 0;
  let containerInspect = 0;
  let probeStarted = false;
  const state = { removed: false };
  const fake = fakeDocker((args) => {
    const [command, sub] = args;
    if (command === 'network' && sub === 'inspect') {
      const override = networkInspections[networkInspect++];
      return ok(JSON.stringify(override ?? networkJson()));
    }
    if (command === 'container' && sub === 'inspect') {
      if (state.removed) return failed('No such container');
      const override = containerInspections[containerInspect++];
      const names = args.slice(2);
      const json =
        override ??
        names.map((name) =>
          containerJson(name, {
            State:
              name.endsWith('-probe') && probeStarted
                ? { Status: 'exited', Running: false, ExitCode: probeExit }
                : {
                    Status: name.endsWith('-probe') ? 'created' : 'running',
                    Running: !name.endsWith('-probe'),
                    ExitCode: 0,
                  },
          }),
        );
      return ok(JSON.stringify(json));
    }
    if (command === 'logs') {
      return ok(
        [
          'logger=provisioning.datasources level=info msg="inserting datasource from configuration" name=Prometheus uid=rasta-prometheus',
          'logger=provisioning.dashboard level=info msg="finished to provision dashboards"',
          'logger=provisioning.alerting level=info msg="finished to provision alerting"',
        ].join('\n'),
      );
    }
    if (command === 'rm') state.removed = true;
    if (command === 'volume') return failed('No such volume');
    return undefined;
  });
  const runProbe = async (name) => {
    fake.calls.push({ args: ['<probe>', name], options: {} });
    probeStarted = true;
    return { status: probeExit, output: probeExit === 0 ? 'PASS' : 'FAIL: boom' };
  };
  return { ...fake, runProbe };
}

async function live(fake) {
  const messages = [];
  const exitCode = await verifyLive({
    docker: fake.docker,
    runProbe: fake.runProbe,
    log: (message) => messages.push(message),
    repoRoot,
    suffix: 'test-000000',
    adminPassword: 'p'.repeat(36),
  });
  const index = (predicate) => fake.calls.findIndex(({ args }) => predicate(args));
  return { exitCode, messages, calls: fake.calls, index };
}

const isCleanupRm = (args) => args[0] === 'rm' && args.includes('-v');
const isNetworkRm = (args) => args[0] === 'network' && args[1] === 'rm' && args[2] === NET;

test('the live orchestrator runs every container through the tested isolation checks', async () => {
  const { exitCode, messages, calls, index } = await live(liveDocker());
  assert.equal(exitCode, 0, messages.join('\n'));

  const create = index((a) => a[0] === 'network' && a[1] === 'create');
  const firstInspect = index((a) => a[0] === 'network' && a[1] === 'inspect');
  const firstRun = index((a) => a[0] === 'run');
  const probe = index((a) => a[0] === '<probe>');
  assert.deepEqual(calls[create].args, ['network', 'create', '--internal', NET]);
  assert.ok(index((a) => a[0] === 'pull' || (a[0] === 'image' && a[1] === 'inspect')) < create);
  assert.ok(
    create < firstInspect && firstInspect < firstRun,
    'network is inspected before containers start',
  );

  const containerInspects = calls
    .map(({ args }, i) => [args, i])
    .filter(([a]) => a[0] === 'container' && a[1] === 'inspect' && a.length === 5);
  assert.ok(
    containerInspects.some(([, i]) => i < probe),
    'containers are inspected before the probe',
  );
  assert.ok(
    containerInspects.some(([, i]) => i > probe),
    'containers are re-inspected after the probe',
  );
  assert.ok(
    calls.some(({ args }, i) => i > probe && args[0] === 'network' && args[1] === 'inspect'),
    'the network is re-inspected after the probe',
  );
  assert.deepEqual(containerInspects[0][0].slice(2), CONTAINERS);

  const started = calls.filter(({ args }) => args[0] === 'run' || args[0] === 'create');
  assert.equal(started.length, 3);
  for (const { args } of started) {
    assert.equal(args[args.indexOf('--network') + 1], NET);
    assert.equal(args.filter((a) => a === '--network' || a.startsWith('--network=')).length, 1);
    assert.ok(!args.some((a) => /^(-p|-P|--publish|--publish-all)(=|$)/.test(a)), args.join(' '));
    assert.ok(!args.some((a) => /docker\.sock/.test(a)));
  }
  const probeCreate = started.find(({ args }) => args[0] === 'create').args;
  assert.ok(probeCreate.includes('node:22-alpine'));
  assert.ok(probeCreate.includes(`${repoRoot}:/workspace:ro`));
  assert.ok(probeCreate.includes('RASTA_DASHCHECK_GRAFANA_URL=http://grafana:3000'));
  for (const { args } of calls)
    assert.ok(!args.join(' ').includes('p'.repeat(36)), 'password in argv');
  assert.ok(messages.some((m) => m.includes(`network ${NET} internal=true`)));
  assert.ok(messages.some((m) => /^after probe: .*publishedPorts=0$/.test(m)));
  assert.ok(calls.some(({ args }) => isNetworkRm(args)));
  assert.ok(
    messages.some((m) =>
      /cleanup: containers left=none networks left=none anonymous volumes removed=3 left=none/.test(
        m,
      ),
    ),
  );
});

test('a topology failure before, around or after the probe fails the run and still cleans up', async () => {
  const publishing = CONTAINERS.map((name) => containerJson(name));
  publishing[1].NetworkSettings.Ports = {
    '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '55001' }],
  };
  const bridged = CONTAINERS.map((name) => containerJson(name));
  bridged[0].NetworkSettings.Networks.bridge = {};
  const scenarios = [
    [
      'network not internal',
      { networkInspections: [networkJson({ Internal: false })] },
      /not internal/,
      false,
    ],
    [
      'published port before probe',
      { containerInspections: [publishing] },
      /grafana publishes host ports/,
      false,
    ],
    [
      'network drifted after probe',
      { networkInspections: [undefined, networkJson({ Internal: false })] },
      /not internal/,
      true,
    ],
    [
      'extra network after probe',
      { containerInspections: [undefined, bridged] },
      /attached to \[.*bridge\]/,
      true,
    ],
    [
      'probe exits nonzero',
      { probeExit: 3 },
      /probe failed: container exited with exit code 3, docker start exited 3\nFAIL: boom/,
      true,
    ],
  ];
  for (const [label, options, pattern, probeRan] of scenarios) {
    const { exitCode, messages, calls, index } = await live(liveDocker(options));
    assert.equal(exitCode, 1, label);
    assert.ok(
      messages.some((m) => m.startsWith('FAIL: ') && pattern.test(m)),
      `${label}:\n${messages.join('\n')}`,
    );
    assert.equal(index((a) => a[0] === '<probe>') >= 0, probeRan, label);
    if (label === 'network not internal')
      assert.equal(
        index((a) => a[0] === 'run'),
        -1,
      );
    assert.ok(
      calls.some(({ args }) => isCleanupRm(args)),
      `${label}: containers removed`,
    );
    assert.ok(
      calls.some(({ args }) => isNetworkRm(args)),
      `${label}: network removed`,
    );
  }
});

test('a failed network create or leftover resource fails the run', async () => {
  const createFails = liveDocker();
  const original = createFails.docker;
  createFails.docker = (args, options) =>
    args[0] === 'network' && args[1] === 'create'
      ? (original(args, { allowFailure: true }), { status: 1, stdout: '', stderr: 'pool overlaps' })
      : original(args, options);
  const failedCreate = await live(createFails);
  assert.equal(failedCreate.exitCode, 1);
  assert.ok(
    failedCreate.messages.some((m) =>
      /FAIL: docker network create --internal .* pool overlaps/.test(m),
    ),
  );
  assert.ok(failedCreate.calls.some(({ args }) => isNetworkRm(args)));

  const leftover = liveDocker();
  const base = leftover.docker;
  leftover.docker = (args, options) =>
    args[0] === 'network' && args[1] === 'ls'
      ? { status: 0, stdout: NET, stderr: '' }
      : base(args, options);
  const left = await live(leftover);
  assert.equal(left.exitCode, 1);
  assert.ok(left.messages.some((m) => m.includes(`networks left=${NET}`)));
});
