#!/usr/bin/env node
/**
 * Proves the tracked Grafana provisioning and dashboard load in the pinned
 * images, that every dashboard query parses in the pinned Prometheus, and that
 * all of it works with no external network route.
 *
 *   node scripts/verify-grafana-dashboard-live.mjs
 *
 * Needs Docker. Starts a throwaway Prometheus v3.1.0 and Grafana 11.5.1, with
 * the real tracked configuration mounted read-only, on a uniquely named Docker
 * `--internal` network with no published ports, so it never collides with or
 * touches a developer's `docker compose` stack. The HTTP/API assertions run in
 * `verify-grafana-dashboard-probe.mjs`, inside a short-lived `node:22-alpine`
 * container on that same network that reaches the two by alias. Not part of
 * `pnpm verify`: Docker is not assumed there.
 *
 * This orchestrator makes sure the images are present before the network
 * exists; proves from `docker network inspect` that the network is internal and
 * from `docker container inspect` that all three containers are attached to it
 * alone with no host port, before the probe starts and again after it exits;
 * requires the probe to exit 0; and checks the Grafana log (not one error or
 * critical line, no plugin install, datasource, dashboard and alerting
 * provisioning finished). It removes exactly its three containers, their
 * anonymous volumes and the network, whether it passes or fails.
 *
 * What passing proves beyond the probe's own list: this disposable stack starts
 * and completes every check without an external route. It says nothing about
 * the development Compose network or any production network policy. Pixel
 * rendering is not checked; no image renderer is installed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED, PATHS, collectTargets } from './check-grafana-dashboard-lib.mjs';
import {
  ALIASES,
  PROBE_ENV,
  createInternalNetwork,
  inspectInternalNetwork,
  inspectIsolatedContainers,
  isolationEvidence,
} from './verify-grafana-dashboard-isolation-lib.mjs';

export const IMAGES = Object.freeze({
  prometheus: 'prom/prometheus:v3.1.0',
  grafana: 'grafana/grafana:11.5.1',
  probe: 'node:22-alpine',
});
const PROBE_WORKDIR = '/workspace';

/** Runs the Docker CLI. Extra `env` reaches the CLI only, so `-e NAME` passes a secret without putting it in argv. */
function dockerCli(args, { allowFailure = false, env } = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: env ? { ...process.env, ...env } : process.env,
  });
  if (result.error) throw new Error(`docker ${args[0]} could not start: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`docker ${args.join(' ')} failed (${result.status}): ${result.stderr.trim()}`);
  }
  return result;
}

/** Starts the created probe container attached, echoing and capturing its output. */
function runProbeCli(container) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('docker', ['start', '--attach', container], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const capture = (chunk) => {
      output += chunk;
      process.stderr.write(chunk);
    };
    child.stdout.setEncoding('utf8').on('data', capture);
    child.stderr.setEncoding('utf8').on('data', capture);
    child.on('error', rejectRun);
    child.on('close', (status) => resolveRun({ status, output }));
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * The whole live check. Docker, the probe runner and logging are injected so
 * the topology wiring can be tested without Docker. Resolves to the exit code.
 */
export async function verifyLive({ docker, runProbe, log, repoRoot, suffix, adminPassword }) {
  const names = {
    network: `rasta-dashcheck-${suffix}`,
    prometheus: `rasta-dashcheck-${suffix}-prometheus`,
    grafana: `rasta-dashcheck-${suffix}-grafana`,
    probe: `rasta-dashcheck-${suffix}-probe`,
  };
  const containers = [names.prometheus, names.grafana, names.probe];
  /** Passed to the Docker CLI's environment only; the container flags name them without a value. */
  const secretEnv = {
    GF_SECURITY_ADMIN_PASSWORD: adminPassword,
    [PROBE_ENV.grafanaPassword]: adminPassword,
  };
  const mount = (path, target) => `${join(repoRoot, path)}:${target}:ro`;

  async function run() {
    const dashboardModel = JSON.parse(readFileSync(join(repoRoot, PATHS.dashboard), 'utf8'));
    const targets = collectTargets(dashboardModel);

    docker(['version', '--format', '{{.Server.Version}}']);
    // Images are acquired by the daemon before the network exists, so a pull is
    // never mistaken for container egress; every container then uses --pull never.
    for (const image of Object.values(IMAGES)) {
      let present = docker(['image', 'inspect', '--format', '{{.Id}}', image], {
        allowFailure: true,
      });
      const acquired = present.status === 0 ? 'present' : 'pulled';
      if (present.status !== 0) {
        docker(['pull', image]);
        present = docker(['image', 'inspect', '--format', '{{.Id}}', image]);
      }
      log(`image ${image} ${acquired} ${present.stdout.trim()}`);
    }

    const network = createInternalNetwork(docker, names.network);
    log(`network ${network.name} internal=${network.internal}`);
    const onNetwork = ['--network', names.network];

    docker([
      'run',
      '-d',
      '--pull',
      'never',
      '--name',
      names.prometheus,
      ...onNetwork,
      '--network-alias',
      ALIASES.prometheus,
      '-v',
      mount('infrastructure/docker/prometheus/prometheus.yml', '/etc/prometheus/prometheus.yml'),
      '-v',
      mount('infrastructure/docker/prometheus/rules', '/etc/prometheus/rules'),
      IMAGES.prometheus,
      '--config.file=/etc/prometheus/prometheus.yml',
    ]);
    docker(
      [
        'run',
        '-d',
        '--pull',
        'never',
        '--name',
        names.grafana,
        ...onNetwork,
        '--network-alias',
        ALIASES.grafana,
        '-e',
        'GF_SECURITY_ADMIN_USER=admin',
        '-e',
        'GF_SECURITY_ADMIN_PASSWORD',
        '-e',
        'GF_USERS_ALLOW_SIGN_UP=false',
        // The same no-outbound settings docker-compose.yml gives the `grafana` service:
        // no analytics, update or news calls, and no first-boot plugin downloads.
        ...Object.entries(EXPECTED.grafanaNoOutboundEnv).flatMap(([name, value]) => [
          '-e',
          `${name}=${value}`,
        ]),
        '-v',
        mount('infrastructure/docker/grafana/provisioning', '/etc/grafana/provisioning'),
        '-v',
        mount(PATHS.dashboardsDir, EXPECTED.dashboardContainerPath),
        IMAGES.grafana,
      ],
      { env: secretEnv },
    );
    docker(
      [
        'create',
        '--pull',
        'never',
        '--name',
        names.probe,
        ...onNetwork,
        '--user',
        'node',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '-v',
        `${repoRoot}:${PROBE_WORKDIR}:ro`,
        '-w',
        PROBE_WORKDIR,
        '-e',
        `${PROBE_ENV.prometheusUrl}=http://${ALIASES.prometheus}:9090`,
        '-e',
        `${PROBE_ENV.grafanaUrl}=http://${ALIASES.grafana}:3000`,
        '-e',
        PROBE_ENV.grafanaPassword,
        IMAGES.probe,
        'node',
        'scripts/verify-grafana-dashboard-probe.mjs',
      ],
      { env: secretEnv },
    );

    const before = inspectIsolatedContainers(docker, names.network, containers);
    log(`before probe: ${isolationEvidence(network, before)}`);

    const probe = await runProbe(names.probe);

    // The pass rests on Docker's state after the probe, not on the arguments above.
    const networkAfter = inspectInternalNetwork(docker, names.network);
    const after = inspectIsolatedContainers(docker, names.network, containers);
    log(`after probe: ${isolationEvidence(networkAfter, after)}`);
    const state = Object.fromEntries(after.map((c) => [c.name, c.state]));
    for (const name of [names.prometheus, names.grafana]) {
      assert(state[name].Running === true, `${name} is not running after the probe`);
    }
    const probeState = state[names.probe];
    assert(
      probeState.Status === 'exited' && probeState.ExitCode === 0 && probe.status === 0,
      `probe failed: container ${probeState.Status} with exit code ${probeState.ExitCode}, ` +
        `docker start exited ${probe.status}\n${probe.output.trim().split('\n').slice(-20).join('\n')}`,
    );
    log(`probe ${names.probe} exited ${probeState.ExitCode}`);

    // Clean startup: not one error or critical line, and every provisioner finished.
    const logs = docker(['logs', names.grafana]);
    const lines = `${logs.stdout}\n${logs.stderr}`.split('\n');
    const provisioningLines = lines.filter((l) => /logger=provisioning/.test(l));
    const errorLines = lines.filter((l) => /level=(error|crit)/.test(l));
    for (const line of provisioningLines) log(`grafana log: ${line.trim()}`);
    assert(
      errorLines.length === 0,
      `Grafana logged ${errorLines.length} error/critical line(s):\n${errorLines.join('\n')}`,
    );
    const evidence = [
      [
        'the datasource was provisioned',
        (l) =>
          /logger=provisioning\.datasources/.test(l) &&
          /from configuration/.test(l) &&
          l.includes(`uid=${EXPECTED.datasourceUid}`),
      ],
      [
        'dashboard provisioning finished',
        (l) =>
          /logger=provisioning\.dashboard/.test(l) && /finished to provision dashboards/.test(l),
      ],
      [
        'alerting provisioning finished',
        (l) => /logger=provisioning\.alerting/.test(l) && /finished to provision alerting/.test(l),
      ],
    ];
    for (const [what, matches] of evidence) {
      assert(lines.some(matches), `Grafana log has no evidence that ${what}`);
    }
    // GF_PLUGINS_PREINSTALL_DISABLED: without it this image logs "Installing plugin"
    // from plugin.backgroundinstaller and downloads app plugins from grafana.com.
    const installerLines = lines.filter((l) =>
      /logger=plugin\.(backgroundinstaller|installer)|msg="Installing plugin"/.test(l),
    );
    assert(
      installerLines.length === 0,
      `Grafana tried to install plugins:\n${installerLines.join('\n')}`,
    );
    log(
      `grafana log: ${lines.length} lines, ${provisioningLines.length} provisioning lines, ` +
        `0 error/critical lines, 0 plugin installer lines; datasource, dashboard and alerting provisioning finished`,
    );
    return { panels: dashboardModel.panels.length, targets: targets.length };
  }

  /** Removes exactly what this run may have created, then proves nothing is left. Never throws. */
  function cleanup() {
    try {
      const inspected = docker(['container', 'inspect', ...containers], { allowFailure: true });
      let volumes = [];
      try {
        volumes = JSON.parse(inspected.stdout || '[]')
          .flatMap((c) => (Array.isArray(c?.Mounts) ? c.Mounts : []))
          .filter((m) => m?.Type === 'volume' && m.Name)
          .map((m) => m.Name);
      } catch {
        // Nothing parseable was created; the name filters below still check containers and network.
      }
      docker(['rm', '-f', '-v', ...containers], { allowFailure: true });
      docker(['network', 'rm', names.network], { allowFailure: true });
      const containersLeft = docker(
        ['ps', '-a', '--filter', `name=${names.network}`, '--format', '{{.Names}}'],
        { allowFailure: true },
      ).stdout.trim();
      const networksLeft = docker(
        ['network', 'ls', '--filter', `name=${names.network}`, '--format', '{{.Name}}'],
        { allowFailure: true },
      ).stdout.trim();
      const volumesLeft = volumes.filter(
        (volume) => docker(['volume', 'inspect', volume], { allowFailure: true }).status === 0,
      );
      log(
        `cleanup: containers left=${containersLeft || 'none'} networks left=${networksLeft || 'none'} ` +
          `anonymous volumes removed=${volumes.length - volumesLeft.length} left=${volumesLeft.join(',') || 'none'}`,
      );
      return containersLeft === '' && networksLeft === '' && volumesLeft.length === 0;
    } catch (error) {
      log(`cleanup could not be verified: ${error.message}`);
      return false;
    }
  }

  let exitCode = 0;
  try {
    const { panels, targets } = await run();
    log(
      `PASS: ${panels} panels, ${targets} queries accepted by Prometheus and Grafana on internal network ${names.network}`,
    );
  } catch (error) {
    exitCode = 1;
    log(`FAIL: ${error.message}`);
    try {
      const tail = docker(['logs', '--tail', '40', names.grafana], { allowFailure: true });
      if (tail.status === 0) log(`grafana log tail:\n${tail.stdout}${tail.stderr}`);
    } catch {
      // The failure above is the report; cleanup still runs.
    }
  } finally {
    if (!cleanup()) exitCode = 1;
  }
  return exitCode;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);
const isMain =
  process.platform === 'win32'
    ? invokedPath.toLowerCase() === modulePath.toLowerCase()
    : invokedPath === modulePath;

if (isMain) {
  process.exit(
    await verifyLive({
      docker: dockerCli,
      runProbe: runProbeCli,
      log: (message) => console.warn(`[dashboard-live] ${message}`),
      repoRoot: resolve(dirname(modulePath), '..'),
      suffix: `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
      // Harness-only login for containers that live for this run. Never stored or printed.
      adminPassword: randomBytes(18).toString('hex'),
    }),
  );
}
