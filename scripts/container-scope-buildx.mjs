// Is the Docker buildx plugin installed? The BuildKit .dockerignore proof in
// container-scope.test.mjs needs it. Only "the tool is absent" may let a local
// run skip that proof; CI never skips, and anything else wrong (a daemon that
// is down, permission denied, a timeout, a failing build) is a failure.
import { spawnSync } from 'node:child_process';

// What the Docker CLI says when the plugin is not installed (older and newer
// wording). `docker buildx version` talks to no daemon, so a stopped daemon
// cannot be mistaken for a missing plugin.
const PLUGIN_ABSENT = /'buildx' is not a docker command|unknown command:? (?:"?docker )?buildx/i;

/**
 * @returns {{ state: 'available' | 'missing' | 'broken', detail?: string }}
 *   missing = no `docker` binary on PATH, or no buildx plugin; broken = the
 *   probe itself failed any other way (EACCES, timeout, killed, other error).
 */
export function probeBuildx({ env = process.env, timeout = 30_000 } = {}) {
  const result = spawnSync('docker', ['buildx', 'version'], { encoding: 'utf8', env, timeout });
  if (result.error) {
    const code = result.error.code ?? 'spawn error';
    return { state: code === 'ENOENT' ? 'missing' : 'broken', detail: code };
  }
  if (result.status === 0) return { state: 'available' };
  if (PLUGIN_ABSENT.test(result.stderr ?? '')) {
    return { state: 'missing', detail: 'the buildx plugin is not installed' };
  }
  return {
    state: 'broken',
    detail: `docker buildx version exited ${result.status ?? result.signal}`,
  };
}

/** Skip locally (never in CI) and only when the tool is absent. */
export function maySkipBuildKitProof(probe, ci = process.env.CI) {
  return probe.state === 'missing' && !ci;
}
