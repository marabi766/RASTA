/**
 * Docker topology checks for the live Grafana dashboard verifier
 * (`verify-grafana-dashboard-live.mjs`).
 *
 * The live stack must run without an external route: Prometheus, Grafana and
 * the Node probe that asserts their APIs share one uniquely named Docker
 * `--internal` network, and nothing publishes a host port (Docker Desktop does
 * not publish ports for a container whose only network is internal anyway).
 * These functions prove that from what Docker reports — `network inspect` and
 * `container inspect` JSON — never from the command arguments alone, and fail
 * closed on anything unexpected.
 *
 * Docker is injected as `docker(args, { allowFailure })` returning
 * `{ status, stdout, stderr }`, so the tests use a fake. Node built-ins only.
 */

/** Container aliases on the internal network; the probe reaches the APIs only through these. */
export const ALIASES = Object.freeze({ prometheus: 'prometheus', grafana: 'grafana' });

/** Harness-only environment the probe container reads. The password is passed by name only. */
export const PROBE_ENV = Object.freeze({
  prometheusUrl: 'RASTA_DASHCHECK_PROMETHEUS_URL',
  grafanaUrl: 'RASTA_DASHCHECK_GRAFANA_URL',
  grafanaPassword: 'RASTA_DASHCHECK_GRAFANA_PASSWORD',
});

function run(docker, args) {
  let result;
  try {
    result = docker(args, { allowFailure: true });
  } catch (error) {
    throw new Error(`docker ${args.join(' ')} failed: ${error.message}`);
  }
  if (!result || result.status !== 0) {
    throw new Error(
      `docker ${args.join(' ')} failed (${result?.status}): ${String(result?.stderr ?? '').trim()}`,
    );
  }
  return String(result.stdout ?? '');
}

function parseInspection(stdout, what) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`${what}: docker inspect did not return JSON`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${what}: docker inspect returned no objects`);
  }
  return parsed;
}

/** Creates `name` as an internal network, then proves it from Docker's own inspection. */
export function createInternalNetwork(docker, name) {
  run(docker, ['network', 'create', '--internal', name]);
  return inspectInternalNetwork(docker, name);
}

/** Exactly one network object, named exactly `name`, with `Internal` the boolean `true`. */
export function inspectInternalNetwork(docker, name) {
  const networks = parseInspection(run(docker, ['network', 'inspect', name]), `network ${name}`);
  if (networks.length !== 1) {
    throw new Error(`network ${name}: expected 1 inspected network, got ${networks.length}`);
  }
  const [network] = networks;
  if (network?.Name !== name) {
    throw new Error(
      `network ${name}: inspection returned network ${JSON.stringify(network?.Name)}`,
    );
  }
  if (network.Internal !== true) {
    throw new Error(
      `network ${name} is not internal (Internal=${JSON.stringify(network.Internal)})`,
    );
  }
  return { name, internal: true };
}

/**
 * Every host binding a container requests or has: `PublishAllPorts`, and any
 * entry in `HostConfig.PortBindings` or `NetworkSettings.Ports`. A null or
 * empty binding list is unpublished; anything else, or a malformed map, counts.
 */
export function publishedBindings(container) {
  const found = [];
  if (container?.HostConfig?.PublishAllPorts === true) found.push('HostConfig.PublishAllPorts');
  for (const [source, map] of [
    ['HostConfig.PortBindings', container?.HostConfig?.PortBindings],
    ['NetworkSettings.Ports', container?.NetworkSettings?.Ports],
  ]) {
    if (map == null) continue;
    if (typeof map !== 'object' || Array.isArray(map)) {
      found.push(`${source} is malformed`);
      continue;
    }
    for (const [port, bindings] of Object.entries(map)) {
      if (bindings == null) continue;
      if (!Array.isArray(bindings)) {
        found.push(`${source} ${port} is malformed`);
        continue;
      }
      for (const b of bindings)
        found.push(`${source} ${port} -> ${b?.HostIp ?? ''}:${b?.HostPort ?? ''}`);
    }
  }
  return found;
}

/**
 * Inspects `containers` and requires each to exist once, to be attached to
 * `network` and nothing else, and to publish no host port. Returns each
 * container's name, `State` and anonymous volume names.
 */
export function inspectIsolatedContainers(docker, network, containers) {
  const inspected = parseInspection(
    run(docker, ['container', 'inspect', ...containers]),
    `containers ${containers.join(', ')}`,
  );
  if (inspected.length !== containers.length) {
    throw new Error(
      `containers: expected ${containers.length} inspected containers, got ${inspected.length}`,
    );
  }
  return containers.map((name) => {
    const matches = inspected.filter((c) => c?.Name === `/${name}`);
    if (matches.length !== 1) {
      throw new Error(`container ${name}: expected 1 inspection result, got ${matches.length}`);
    }
    const [container] = matches;
    const networks = container.NetworkSettings?.Networks;
    const attached =
      networks && typeof networks === 'object' && !Array.isArray(networks)
        ? Object.keys(networks)
        : [];
    if (attached.length !== 1 || attached[0] !== network) {
      throw new Error(
        `container ${name} is attached to [${attached.join(', ')}], expected only ${network}`,
      );
    }
    if (container.HostConfig?.NetworkMode !== network) {
      throw new Error(
        `container ${name} network mode is ${JSON.stringify(container.HostConfig?.NetworkMode)}, expected ${network}`,
      );
    }
    const bindings = publishedBindings(container);
    if (bindings.length > 0) {
      throw new Error(`container ${name} publishes host ports: ${bindings.join('; ')}`);
    }
    const volumes = (Array.isArray(container.Mounts) ? container.Mounts : [])
      .filter((m) => m?.Type === 'volume')
      .map((m) => m.Name);
    return { name, state: container.State ?? {}, volumes };
  });
}

/** One evidence line for a proven isolated topology. */
export function isolationEvidence(network, containers) {
  return (
    `network ${network.name} internal=${network.internal}; ` +
    `${containers.length} containers attached only to it (${containers.map((c) => c.name).join(', ')}); ` +
    `publishedPorts=0`
  );
}

/**
 * Validates the probe's harness-only environment. URLs must be plain
 * `http://<single-label alias>:<port>` — no IP, domain, credentials or path —
 * so the probe cannot be pointed anywhere but a container on its own network.
 * The password is required but never echoed.
 */
export function readProbeEnvironment(env) {
  const url = (key) => {
    const raw = env[key];
    if (!raw) throw new Error(`${key} is required`);
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(`${key} is not a URL`);
    }
    const plain =
      parsed.protocol === 'http:' &&
      /^[a-z][a-z0-9-]*$/.test(parsed.hostname) &&
      parsed.port !== '' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.pathname === '/' &&
      parsed.search === '' &&
      parsed.hash === '';
    if (!plain) throw new Error(`${key} must be http://<container alias>:<port>`);
    return parsed.origin;
  };
  const password = env[PROBE_ENV.grafanaPassword];
  if (typeof password !== 'string' || password.length < 16) {
    throw new Error(`${PROBE_ENV.grafanaPassword} is required (at least 16 characters)`);
  }
  return {
    prometheus: url(PROBE_ENV.prometheusUrl),
    grafana: url(PROBE_ENV.grafanaUrl),
    password,
  };
}
