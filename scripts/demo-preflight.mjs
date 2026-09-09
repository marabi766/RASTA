/**
 * Read-only readiness check for the investor demo.
 *
 * Answers one question — "is this machine ready to present?" — and answers it
 * without changing anything. It opens TCP connections, issues `GET` requests to
 * health endpoints, and reads files. It starts nothing, stops nothing, migrates
 * nothing and seeds nothing.
 *
 * That restraint is the point rather than an omission. A preflight that quietly
 * fixed what it found would be the worst possible tool to run five minutes
 * before a presentation, on a machine somebody else may also be using: the one
 * time you need to know the true state is the one time a self-healing script
 * hides it. When something is missing it prints the exact command to run and
 * stops.
 *
 * Usage:
 *   node scripts/demo-preflight.mjs
 *   node scripts/demo-preflight.mjs --json
 *
 * Exit code 0 when the portal can be demonstrated end to end, 1 otherwise. The
 * frontend-only walkthrough needs far less than a full pass, and the summary
 * says which of the two levels was reached.
 */

import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const JSON_OUTPUT = process.argv.includes('--json');

// ---------------------------------------------------------------------------
// Configuration, read from the same `.env` everything else reads
// ---------------------------------------------------------------------------

function readEnvFile() {
  const file = path.join(ROOT, '.env');
  if (!existsSync(file)) return null;

  /** @type {Record<string, string>} */
  const values = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match) values[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

const env = readEnvFile();

/** `.env` first, then the documented default. Never a silent guess at runtime. */
function setting(name, fallback) {
  return process.env[name] ?? env?.[name] ?? fallback;
}

function originOf(url, fallback) {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)),
      url,
    };
  } catch {
    return fallback;
  }
}

const gateway = originOf(setting('NEXT_PUBLIC_API_BASE_URL', 'http://localhost:3000'), {
  host: 'localhost',
  port: 3000,
  url: 'http://localhost:3000',
});

const keycloak = originOf(setting('NEXT_PUBLIC_KEYCLOAK_URL', 'http://localhost:8080'), {
  host: 'localhost',
  port: 8080,
  url: 'http://localhost:8080',
});

const realm = setting('NEXT_PUBLIC_KEYCLOAK_REALM', 'rasta');

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

/**
 * Opens a socket and closes it. The cheapest honest "is anything there".
 *
 * `once('close')` rather than resolving straight from `connect` is deliberate:
 * resolving early and then calling `process.exit()` while the handle is still
 * closing trips a libuv assertion on Windows (`!(handle->flags &
 * UV_HANDLE_CLOSING)`), which turns a clean report into exit code 127. Waiting
 * for the close event means every handle is finished before the process is.
 */
function tcpOpen(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let outcome = false;

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      outcome = true;
      socket.destroy();
    });
    socket.once('timeout', () => socket.destroy());
    socket.once('error', () => socket.destroy());
    socket.once('close', () => resolve(outcome));

    socket.connect(port, host);
  });
}

async function httpStatus(url, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    return response.status;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/**
 * Each check states what it needs and, when it fails, what to run.
 *
 * `level` separates the two useful outcomes: `frontend` is everything the
 * walkthrough and the not-built screens need, `full` adds what the live
 * screens need. A machine that passes only the first can still present most of
 * the product honestly, and the summary says so rather than reporting a flat
 * failure.
 */
const checks = [
  {
    id: 'env-file',
    level: 'frontend',
    label: '.env در ریشهٔ مخزن',
    async run() {
      if (!env) {
        return {
          ok: false,
          detail: 'فایل .env وجود ندارد.',
          fix: 'cp .env.example .env',
        };
      }

      const missing = [
        'NEXT_PUBLIC_API_BASE_URL',
        'NEXT_PUBLIC_KEYCLOAK_URL',
        'NEXT_PUBLIC_KEYCLOAK_REALM',
        'NEXT_PUBLIC_KEYCLOAK_CLIENT_ID',
      ].filter((key) => !env[key]);

      return missing.length === 0
        ? { ok: true, detail: 'چهار متغیر عمومی رابط کاربری موجودند.' }
        : {
            ok: false,
            detail: `متغیر ناقص: ${missing.join('، ')}`,
            fix: 'مقادیر NEXT_PUBLIC_* را از .env.example در .env کپی کنید.',
          };
    },
  },
  {
    id: 'node-modules',
    level: 'frontend',
    label: 'وابستگی‌های نصب‌شده',
    async run() {
      const installed = existsSync(path.join(ROOT, 'node_modules'));
      return installed
        ? { ok: true, detail: 'node_modules موجود است.' }
        : { ok: false, detail: 'وابستگی‌ها نصب نشده‌اند.', fix: 'pnpm install' };
    },
  },
  {
    id: 'portal-port',
    level: 'frontend',
    label: 'پورت ۳۲۰۰ برای پورتال',
    async run() {
      const busy = await tcpOpen('127.0.0.1', 3200);
      if (!busy) return { ok: true, detail: 'آزاد است؛ پورتال می‌تواند بالا بیاید.' };

      const status = await httpStatus('http://localhost:3200/');

      if (status !== null && status < 500) {
        return { ok: true, detail: `پورتال روی ۳۲۰۰ پاسخ می‌دهد (${status}).` };
      }

      // A 5xx is not "occupied by something else" — it is the portal itself
      // failing, and reporting that as ready would be the one lie this script
      // exists to prevent. The commonest cause on a developer machine is a
      // production `next build` run while `next dev` was serving the same
      // `.next` directory.
      return status === null
        ? {
            ok: false,
            detail: 'پورت ۳۲۰۰ اشغال است اما پاسخ HTTP نمی‌دهد.',
            fix: 'فرایندی که پورت ۳۲۰۰ را گرفته پیدا کنید: netstat -ano | findstr :3200',
          }
        : {
            ok: false,
            detail: `پورتال پاسخ ${status} می‌دهد.`,
            fix: 'rm -rf apps/web/.next  و سپس  pnpm --filter @rasta/web dev',
          };
    },
  },
  {
    id: 'keycloak',
    level: 'frontend',
    label: 'Keycloak و Realm',
    async run() {
      const reachable = await tcpOpen(keycloak.host, keycloak.port);
      if (!reachable) {
        return {
          ok: false,
          detail: `${keycloak.url} در دسترس نیست.`,
          fix: 'docker compose up -d keycloak',
        };
      }

      const discovery = `${keycloak.url.replace(/\/+$/, '')}/realms/${realm}/.well-known/openid-configuration`;
      const status = await httpStatus(discovery);

      return status === 200
        ? { ok: true, detail: `Realm «${realm}» پاسخ می‌دهد.` }
        : {
            ok: false,
            detail: `سند Discovery برای Realm «${realm}» پاسخ ${status ?? 'نداد'}.`,
            fix: 'docker compose logs keycloak --tail 50',
          };
    },
  },
  {
    id: 'gateway',
    level: 'full',
    label: 'درگاه API',
    async run() {
      const reachable = await tcpOpen(gateway.host, gateway.port);
      if (!reachable) {
        return {
          ok: false,
          detail: `${gateway.url} در دسترس نیست.`,
          fix: `pnpm --filter @rasta/api-gateway dev  (و بررسی کنید PORT_API_GATEWAY با NEXT_PUBLIC_API_BASE_URL یکی باشد)`,
        };
      }

      const status = await httpStatus(`${gateway.url.replace(/\/+$/, '')}/health`);
      return status && status < 500
        ? { ok: true, detail: `پاسخ می‌دهد (${status}).` }
        : {
            ok: false,
            detail: `پاسخ سلامت: ${status ?? 'بدون پاسخ'}.`,
            fix: 'لاگ درگاه را ببینید.',
          };
    },
  },
  {
    id: 'infrastructure',
    level: 'full',
    label: 'زیرساخت پایه (PostgreSQL، Redis، Kafka)',
    async run() {
      const targets = [
        ['PostgreSQL', Number(setting('POSTGRES_PORT', '5432'))],
        ['Redis', Number(setting('REDIS_PORT', '6379'))],
        ['Kafka', Number(setting('KAFKA_HOST_PORT', '9092'))],
      ];

      const results = await Promise.all(
        targets.map(async ([name, port]) => [name, port, await tcpOpen('127.0.0.1', port)]),
      );

      const down = results.filter(([, , up]) => !up);
      return down.length === 0
        ? { ok: true, detail: results.map(([name, port]) => `${name}:${port}`).join('، ') }
        : {
            ok: false,
            detail: `در دسترس نیست: ${down.map(([name, port]) => `${name}:${port}`).join('، ')}`,
            fix: 'pnpm infra:up',
          };
    },
  },
  {
    id: 'services',
    level: 'full',
    label: 'سرویس‌های پیاده‌شده',
    async run() {
      const services = [
        ['identity', Number(setting('PORT_IDENTITY', '3101'))],
        ['organization', Number(setting('PORT_ORGANIZATION', '3102'))],
        ['asset', Number(setting('PORT_ASSET', '3103'))],
        ['fleet', Number(setting('PORT_FLEET', '3104'))],
        ['maintenance', Number(setting('PORT_MAINTENANCE', '3105'))],
        ['marketplace', Number(setting('PORT_MARKETPLACE', '3106'))],
        ['supplier', Number(setting('PORT_SUPPLIER', '3108'))],
        ['economic', Number(setting('PORT_ECONOMIC', '3112'))],
        ['document', Number(setting('PORT_DOCUMENT', '3114'))],
      ];

      const results = await Promise.all(
        services.map(async ([name, port]) => [name, port, await tcpOpen('127.0.0.1', port)]),
      );

      const up = results.filter(([, , alive]) => alive);
      const down = results.filter(([, , alive]) => !alive);

      return down.length === 0
        ? { ok: true, detail: `هر ${results.length} سرویس در حال اجراست.` }
        : {
            ok: false,
            detail:
              `${up.length} از ${results.length} سرویس بالاست. ` +
              `خاموش: ${down.map(([name]) => name).join('، ')}`,
            fix: 'pnpm dev   (یا هر سرویس جداگانه: pnpm --filter @rasta/<name>-service dev)',
          };
    },
  },
];

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const results = [];
for (const check of checks) {
  const outcome = await check.run();
  results.push({ id: check.id, level: check.level, label: check.label, ...outcome });
}

const frontendReady = results.filter((r) => r.level === 'frontend').every((r) => r.ok);
const fullReady = frontendReady && results.every((r) => r.ok);

if (JSON_OUTPUT) {
  process.stdout.write(`${JSON.stringify({ frontendReady, fullReady, results }, null, 2)}\n`);
} else {
  process.stdout.write('\nپیش‌پرواز نمایش رستا — فقط خواندنی، هیچ چیزی تغییر نمی‌کند\n\n');

  for (const result of results) {
    const mark = result.ok ? 'OK  ' : 'FAIL';
    const scope = result.level === 'frontend' ? '[رابط]' : '[کامل]';
    process.stdout.write(`  ${mark} ${scope} ${result.label}\n        ${result.detail}\n`);
    if (!result.ok && result.fix) process.stdout.write(`        اجرا کنید: ${result.fix}\n`);
    process.stdout.write('\n');
  }

  if (fullReady) {
    process.stdout.write('همه‌چیز آماده است. سناریوی کامل، شامل صفحه‌های LIVE، قابل نمایش است.\n');
  } else if (frontendReady) {
    process.stdout.write(
      'رابط کاربری آماده است: روایت هدایت‌شده، داشبورد، نقشهٔ قابلیت‌ها، صفحه‌های ساخته‌نشده و\n' +
        'ورود واقعی Keycloak کار می‌کنند. صفحه‌های LIVE تا بالا آمدن درگاه و سرویس‌ها،\n' +
        'وضعیت «در دسترس نیست» را صادقانه نشان می‌دهند.\n',
    );
  } else {
    process.stdout.write('آمادهٔ نمایش نیست. موارد FAIL بالا را به‌ترتیب برطرف کنید.\n');
  }

  process.stdout.write(
    '\nشروع پورتال:  pnpm --filter @rasta/web dev    →    http://localhost:3200\n\n',
  );
}

// `exitCode` rather than `exit()`: the process ends once the event loop is
// empty, so nothing is torn down mid-close.
process.exitCode = fullReady ? 0 : 1;
