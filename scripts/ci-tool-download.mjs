// Linux x64 release archives only. Cache bytes are rechecked before every extraction.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const TOOLS = {
  go: {
    version: '1.24.9',
    sha256: '5b7899591c2dd6e9da1809fde4a2fad842c45d3f6b9deb235ba82216e31e34a6',
    url: 'https://go.dev/dl/go1.24.9.linux-amd64.tar.gz',
    bin: 'go/bin',
  },
  gitleaks: {
    version: '8.30.1',
    sha256: '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
    url: 'https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz',
    bin: '.',
  },
};
export const BACKOFF = [5, 15, 30];
// Four transfers (155s process limits) + 50s backoff + 60s extraction fit in 13 minutes.
export function transient(code, http) {
  return (
    // Transport failure: http can still describe an earlier redirect hop.
    [5, 6, 7, 16, 18, 28, 35, 52, 55, 56, 80, 92, 95, 96].includes(code) ||
    // Only an HTTP failure (22) makes the final response authoritative.
    (code === 22 && ['408', '429', '500', '502', '503', '504'].includes(http))
  );
}
export function download(
  tool,
  archive,
  { curl = spawnSync, sleep = (s) => spawnSync('sleep', [String(s)]) } = {},
) {
  const verify = (file) => {
    return createHash('sha256').update(readFileSync(file)).digest('hex') === tool.sha256;
  };
  if (existsSync(archive)) {
    if (verify(archive)) return;
    rmSync(archive); // Immutable remote cache may stay corrupt; never extract its bytes.
  }
  const partial = `${archive}.partial`;
  try {
    for (let attempt = 0; ; attempt++) {
      rmSync(partial, { force: true });
      const result = curl(
        'curl',
        [
          '--fail',
          '--silent',
          '--show-error',
          '--location',
          '--proto',
          '=https',
          '--proto-redir',
          '=https',
          '--connect-timeout',
          '20',
          '--max-time',
          '150',
          '--output',
          partial,
          '--write-out',
          '%{http_code}',
          tool.url,
        ],
        { encoding: 'utf8', timeout: 155_000, maxBuffer: 1024 * 1024 },
      );
      if (result.status === 0) {
        if (!verify(partial))
          throw new Error('tool archive checksum mismatch; refusing without retry');
        renameSync(partial, archive);
        return;
      }
      if (attempt === BACKOFF.length || !transient(result.status, result.stdout?.trim()))
        throw new Error('tool download failed or retry budget exhausted');
      const slept = sleep(BACKOFF[attempt]);
      if (slept?.status !== 0) throw new Error('tool download backoff failed');
    }
  } finally {
    rmSync(partial, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, name, ...extra] = process.argv.slice(2);
    if (
      extra.length ||
      !['key', 'install'].includes(mode) ||
      !Object.hasOwn(TOOLS, name) ||
      process.platform !== 'linux' ||
      process.arch !== 'x64' ||
      !process.env.RUNNER_TEMP
    )
      throw new Error('unsupported tool invocation');
    const tool = TOOLS[name];
    // FU-288: rotate the immutable remote namespace; old corrupt entries cannot be overwritten.
    const key = `ci-tool-v2-linux-x64-${name}-${tool.version}-${tool.sha256}`;
    const cache = join(process.env.RUNNER_TEMP, 'ci-tool-archives');
    const archive = join(cache, `${key}.tar.gz`);
    if (mode === 'key') {
      appendFileSync(process.env.GITHUB_OUTPUT, `key=${key}\narchive=${archive}\n`);
    } else {
      mkdirSync(cache, { recursive: true });
      download(tool, archive);
      const target = join(process.env.RUNNER_TEMP, key);
      rmSync(target, { recursive: true, force: true });
      mkdirSync(target);
      const unpack = spawnSync('tar', ['-xzf', archive, '-C', target], { timeout: 60_000 });
      if (unpack.status !== 0) throw new Error('verified tool extraction failed');
      appendFileSync(process.env.GITHUB_PATH, `${join(target, tool.bin)}\n`);
      if (name === 'go') appendFileSync(process.env.GITHUB_ENV, `GOROOT=${join(target, 'go')}\n`);
    }
  } catch (error) {
    process.stderr.write(`::error::${error.message}\n`);
    process.exitCode = 1;
  }
}
