/**
 * Starts the portal in a named data mode.
 *
 * ## Why a script rather than an inline environment assignment
 *
 * `NEXT_PUBLIC_DEMO_DATA_MODE=fixture next dev` is bash syntax. On Windows —
 * which is where this demo runs — `cmd.exe` reads it as a command name and
 * fails, and PowerShell rejects it as a parse error. A package script has to
 * work in whatever shell the reader happens to have, and the only thing that
 * reliably does is a Node process that sets the variable itself and spawns the
 * child.
 *
 * ## What it does not do
 *
 * It starts one dev server and nothing else. It touches no Docker container, no
 * database, no migration and no seed; it kills no process and frees no port.
 * The live mode here is only the *frontend* half — the backend stack belongs to
 * whoever owns the integration environment, and `docs/demo/investor-preview.md`
 * says so rather than this script quietly starting it.
 *
 * Usage:
 *   node scripts/run-demo-web.mjs --mode fixture
 *   node scripts/run-demo-web.mjs --mode live --command start
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const WEB = path.join(ROOT, 'apps', 'web');

const MODES = new Set(['fixture', 'live']);
const COMMANDS = new Set(['dev', 'build', 'start']);

const mode = readFlag('--mode', 'fixture');
const command = readFlag('--command', 'dev');

if (!MODES.has(mode)) {
  fail(`Unknown mode "${mode}". Expected one of: ${[...MODES].join(', ')}`);
}
if (!COMMANDS.has(command)) {
  fail(`Unknown command "${command}". Expected one of: ${[...COMMANDS].join(', ')}`);
}

/**
 * Live mode needs the gateway and realm coordinates; fixture mode contacts
 * neither, so it can supply placeholders and start on a machine that has no
 * `.env` at all. That is the whole point of the portable mode — a laptop with
 * Node and this repository, and nothing else.
 *
 * The placeholders are syntactically valid URLs because `readPublicEnv`
 * validates them, and `.invalid` is reserved by RFC 2606 so they can never
 * resolve to a host. Nothing in fixture mode reads them; they exist so the
 * configuration check has something well-formed to pass.
 */
const FIXTURE_PLACEHOLDERS = {
  NEXT_PUBLIC_API_BASE_URL: 'http://gateway.invalid',
  NEXT_PUBLIC_KEYCLOAK_URL: 'http://identity.invalid',
  NEXT_PUBLIC_KEYCLOAK_REALM: 'rasta',
  NEXT_PUBLIC_KEYCLOAK_CLIENT_ID: 'rasta-web',
};

const env = { ...process.env, NEXT_PUBLIC_DEMO_DATA_MODE: mode };

if (mode === 'fixture') {
  for (const [key, value] of Object.entries(FIXTURE_PLACEHOLDERS)) {
    env[key] ??= value;
  }
} else {
  const missing = requiredLiveSettings().filter((key) => !env[key] && !rootEnvHas(key));
  if (missing.length > 0) {
    fail(
      `Live mode needs ${missing.join(', ')}.\n` +
        'Copy .env.demo.example to .env at the repository root and set NEXT_PUBLIC_DEMO_DATA_MODE=live.',
    );
  }
}

process.stdout.write(
  `\nRasta portal — ${mode === 'fixture' ? 'presentation fixtures' : 'live API'} · next ${command}\n` +
    (mode === 'fixture'
      ? 'No backend is contacted. Every record on screen is invented and labelled as such.\n\n'
      : 'Reads through the API Gateway. Start the backend stack separately.\n\n'),
);

const child = spawn('npx', ['next', command, ...(command === 'build' ? [] : ['--port', '3200'])], {
  cwd: WEB,
  env,
  stdio: 'inherit',
  // Windows resolves `npx` through a shim rather than an executable.
  shell: process.platform === 'win32',
});

child.on('exit', (code, signal) => {
  // Mirrors the child's fate rather than inventing one, so a Ctrl-C reads as an
  // interrupt and a crash reads as a crash.
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 0;
});

function readFlag(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

function requiredLiveSettings() {
  return [
    'NEXT_PUBLIC_API_BASE_URL',
    'NEXT_PUBLIC_KEYCLOAK_URL',
    'NEXT_PUBLIC_KEYCLOAK_REALM',
    'NEXT_PUBLIC_KEYCLOAK_CLIENT_ID',
  ];
}

/** `next.config.mjs` reads the root `.env` itself; this mirrors that lookup. */
function rootEnvHas(key) {
  const file = path.join(ROOT, '.env');
  if (!existsSync(file)) return false;
  return new RegExp(`^\\s*${key}\\s*=\\s*\\S`, 'm').test(readFileSync(file, 'utf8'));
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
