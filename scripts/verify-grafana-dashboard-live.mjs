#!/usr/bin/env node
/**
 * Proves the tracked Grafana provisioning and dashboard load in the pinned
 * images and that every dashboard query parses in the pinned Prometheus.
 *
 *   node scripts/verify-grafana-dashboard-live.mjs
 *
 * Needs Docker. Starts its own throwaway Prometheus v3.1.0 and Grafana 11.5.1
 * on a uniquely named network, with the real tracked configuration mounted
 * read-only and host ports chosen by Docker on 127.0.0.1, so it never collides
 * with or touches a developer's `docker compose` stack. Removes exactly the two
 * containers (with their anonymous volumes) and the network it created, whether
 * it passes or fails. Not part of `pnpm verify`: Docker is not assumed there.
 *
 * What passing proves: Grafana provisioned the datasource with the stable UID
 * and URL and can reach Prometheus through it; the dashboard is in the `Rasta`
 * folder with the exact UID, title, panel and query count; the dashboard page
 * is served; Grafana logged no provisioning error; Prometheus loaded the rules
 * file; and every query is accepted by Prometheus directly and through
 * Grafana. With no scrape targets running, results are mostly empty — that is
 * expected, and says nothing about what the panels would show with real data.
 * Pixel rendering is not checked; no image renderer is installed.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED, PATHS, collectTargets, parseRuleNames } from './check-grafana-dashboard-lib.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROMETHEUS_IMAGE = 'prom/prometheus:v3.1.0';
const GRAFANA_IMAGE = 'grafana/grafana:11.5.1';
const suffix = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
const names = {
  network: `rasta-dashcheck-${suffix}`,
  prometheus: `rasta-dashcheck-${suffix}-prometheus`,
  grafana: `rasta-dashcheck-${suffix}-grafana`,
};
/** Harness-only login for a container that lives for this run. Never stored. */
const adminPassword = randomBytes(18).toString('hex');
const auth = `Basic ${Buffer.from(`admin:${adminPassword}`).toString('base64')}`;
/** Fixed substitutions for Grafana interval macros, used only to submit queries to Prometheus. */
const MACROS = [
  [/\$__rate_interval\b/g, '5m'],
  [/\$__interval\b/g, '1m'],
  [/\$__range\b/g, '1h'],
];

const log = (message) => console.warn(`[dashboard-live] ${message}`);

function docker(args, { allowFailure = false } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.error) throw new Error(`docker ${args[0]} could not start: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`docker ${args.join(' ')} failed (${result.status}): ${result.stderr.trim()}`);
  }
  return result;
}

const mount = (path, target) => `${join(repoRoot, path)}:${target}:ro`;

function hostPort(container, port) {
  const out = docker(['port', container, `${port}/tcp`])
    .stdout.trim()
    .split('\n')[0];
  const match = /:(\d+)$/.exec(out);
  if (!match) throw new Error(`no published host port for ${container}:${port} (${out})`);
  return Number(match[1]);
}

async function waitFor(what, fn, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
    } catch (error) {
      last = error;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
}

async function getJson(url, headers = {}) {
  const response = await fetch(url, { headers });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function run() {
  const dashboardModel = JSON.parse(readFileSync(join(repoRoot, PATHS.dashboard), 'utf8'));
  const targets = collectTargets(dashboardModel);
  const rules = parseRuleNames(readFileSync(join(repoRoot, PATHS.rules), 'utf8'));

  docker(['version', '--format', '{{.Server.Version}}']);
  log(`network ${names.network}`);
  docker(['network', 'create', names.network]);

  docker([
    'run',
    '-d',
    '--name',
    names.prometheus,
    '--network',
    names.network,
    '--network-alias',
    'prometheus',
    '-p',
    '127.0.0.1::9090',
    '-v',
    mount('infrastructure/docker/prometheus/prometheus.yml', '/etc/prometheus/prometheus.yml'),
    '-v',
    mount('infrastructure/docker/prometheus/rules', '/etc/prometheus/rules'),
    PROMETHEUS_IMAGE,
    '--config.file=/etc/prometheus/prometheus.yml',
  ]);
  docker([
    'run',
    '-d',
    '--name',
    names.grafana,
    '--network',
    names.network,
    '-p',
    '127.0.0.1::3000',
    '-e',
    'GF_SECURITY_ADMIN_USER=admin',
    '-e',
    `GF_SECURITY_ADMIN_PASSWORD=${adminPassword}`,
    '-e',
    'GF_USERS_ALLOW_SIGN_UP=false',
    '-e',
    'GF_ANALYTICS_REPORTING_ENABLED=false',
    '-e',
    'GF_ANALYTICS_CHECK_FOR_UPDATES=false',
    '-e',
    'GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES=false',
    '-e',
    'GF_NEWS_NEWS_FEED_ENABLED=false',
    // Grafana 11 otherwise downloads preinstalled app plugins from grafana.com.
    '-e',
    'GF_PLUGINS_PREINSTALL_DISABLED=true',
    '-v',
    mount('infrastructure/docker/grafana/provisioning', '/etc/grafana/provisioning'),
    '-v',
    mount(PATHS.dashboardsDir, EXPECTED.dashboardContainerPath),
    GRAFANA_IMAGE,
  ]);

  const prom = `http://127.0.0.1:${hostPort(names.prometheus, 9090)}`;
  const grafana = `http://127.0.0.1:${hostPort(names.grafana, 3000)}`;
  const authed = { Authorization: auth };

  await waitFor('Prometheus ready', async () => (await fetch(`${prom}/-/ready`)).ok);
  await waitFor(
    'Grafana healthy',
    async () => {
      const { status, body } = await getJson(`${grafana}/api/health`);
      return status === 200 && body.database === 'ok';
    },
    480_000,
  ); // A first boot runs every SQLite migration; on a slow Docker disk that took over two minutes.
  log(`Prometheus ${prom} ready; Grafana ${grafana} healthy`);

  // Prometheus loaded the tracked rules file.
  const loaded = await getJson(`${prom}/api/v1/rules`);
  const loadedRules = loaded.body.data.groups.flatMap((g) => g.rules);
  const alertCount = loadedRules.filter((r) => r.type === 'alerting').length;
  const recordCount = loadedRules.filter((r) => r.type === 'recording').length;
  assert(
    alertCount === rules.alerts.length && recordCount === rules.records.length,
    `Prometheus loaded ${alertCount} alerts/${recordCount} records, rules file has ${rules.alerts.length}/${rules.records.length}`,
  );
  log(`Prometheus loaded ${alertCount} alerting + ${recordCount} recording rules`);

  // Datasource: stable UID, URL, default, and reachable from Grafana.
  let datasource;
  await waitFor(
    'provisioned datasource',
    async () => {
      datasource = await getJson(
        `${grafana}/api/datasources/uid/${EXPECTED.datasourceUid}`,
        authed,
      );
      return datasource.status === 200;
    },
    60_000,
  );
  const ds = datasource.body;
  assert(ds.uid === EXPECTED.datasourceUid, `datasource uid ${ds.uid}`);
  assert(ds.url === EXPECTED.datasourceUrl, `datasource url ${ds.url}`);
  assert(ds.name === 'Prometheus' && ds.type === 'prometheus', `datasource ${ds.name}/${ds.type}`);
  assert(
    ds.isDefault === true && ds.access === 'proxy',
    `datasource default/access ${ds.isDefault}/${ds.access}`,
  );
  log(
    `datasource name=${ds.name} uid=${ds.uid} url=${ds.url} isDefault=${ds.isDefault} access=${ds.access} readOnly=${ds.readOnly}`,
  );
  const health = await getJson(
    `${grafana}/api/datasources/uid/${EXPECTED.datasourceUid}/health`,
    authed,
  );
  assert(
    health.status === 200 && health.body.status === 'OK',
    `datasource health ${health.status} ${JSON.stringify(health.body)}`,
  );
  log(`datasource health: ${health.body.status} (${health.body.message})`);

  // Dashboard: folder, UID, title, provisioned, panel and target counts.
  let dashboard;
  await waitFor(
    'provisioned dashboard',
    async () => {
      dashboard = await getJson(`${grafana}/api/dashboards/uid/${EXPECTED.uid}`, authed);
      return dashboard.status === 200;
    },
    60_000,
  );
  const { meta, dashboard: model } = dashboard.body;
  const apiTargets = collectTargets(model);
  assert(
    model.uid === EXPECTED.uid && model.title === EXPECTED.title,
    `dashboard ${model.uid}/${model.title}`,
  );
  assert(meta.folderTitle === EXPECTED.folder, `dashboard folder ${meta.folderTitle}`);
  assert(meta.provisioned === true, 'dashboard is not marked provisioned');
  assert(model.panels.length === dashboardModel.panels.length, `panels ${model.panels.length}`);
  assert(apiTargets.length === targets.length, `targets ${apiTargets.length}`);
  assert(
    apiTargets.every(({ target }) => target.datasource?.uid === EXPECTED.datasourceUid),
    'an API-returned target does not use the stable datasource UID',
  );
  log(
    `dashboard uid=${model.uid} title="${model.title}" folder=${meta.folderTitle} folderUid=${meta.folderUid} ` +
      `provisioned=${meta.provisioned} canDelete=${meta.canDelete} panels=${model.panels.length} targets=${apiTargets.length}`,
  );
  const folder = await getJson(`${grafana}/api/folders/${meta.folderUid}`, authed);
  assert(folder.status === 200 && folder.body.title === EXPECTED.folder, `folder ${folder.status}`);

  // disableDeletion: even the admin cannot delete the provisioned dashboard.
  const deletion = await fetch(`${grafana}/api/dashboards/uid/${EXPECTED.uid}`, {
    method: 'DELETE',
    headers: authed,
  });
  const deletionBody = await deletion.text();
  const afterDelete = await getJson(`${grafana}/api/dashboards/uid/${EXPECTED.uid}`, authed);
  assert(
    deletion.status !== 200 && afterDelete.status === 200,
    `provisioned dashboard deletion returned ${deletion.status}; afterwards GET ${afterDelete.status}`,
  );
  log(
    `DELETE provisioned dashboard -> ${deletion.status} ${deletionBody.trim().slice(0, 120)}; still present`,
  );

  // Every query parses and evaluates in Prometheus, directly and through Grafana.
  for (const { panel, target } of targets) {
    let expr = target.expr;
    for (const [pattern, value] of MACROS) expr = expr.replace(pattern, value);
    const direct = await getJson(`${prom}/api/v1/query?query=${encodeURIComponent(expr)}`);
    assert(
      direct.status === 200 && direct.body.status === 'success',
      `panel ${panel.id} ${target.refId}: Prometheus rejected query (${direct.status}): ${JSON.stringify(direct.body)}`,
    );
    const viaGrafana = await fetch(`${grafana}/api/ds/query`, {
      method: 'POST',
      headers: { ...authed, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'now-1h',
        to: 'now',
        queries: [
          {
            refId: target.refId,
            datasource: { type: 'prometheus', uid: EXPECTED.datasourceUid },
            expr: target.expr,
            range: target.range === true,
            instant: target.instant === true,
            intervalMs: 15000,
            maxDataPoints: 240,
          },
        ],
      }),
    });
    const grafanaBody = await viaGrafana.json();
    const frame = grafanaBody.results?.[target.refId];
    assert(
      viaGrafana.status === 200 && frame && !frame.error,
      `panel ${panel.id} ${target.refId}: Grafana query failed (${viaGrafana.status}): ${JSON.stringify(grafanaBody).slice(0, 400)}`,
    );
    log(
      `query ok panel=${panel.id} ref=${target.refId} resultType=${direct.body.data.resultType} ` +
        `series=${direct.body.data.result.length} grafanaFrames=${frame.frames?.length ?? 0}`,
    );
  }

  // The dashboard page is served.
  const page = await fetch(`${grafana}/d/${EXPECTED.uid}`, { headers: authed, redirect: 'manual' });
  assert(page.status === 200, `dashboard page returned ${page.status}`);
  log(`GET /d/${EXPECTED.uid} -> ${page.status}`);

  // Grafana logged no provisioning or datasource error.
  const logs = docker(['logs', names.grafana]);
  const lines = `${logs.stdout}\n${logs.stderr}`.split('\n');
  const provisioningLines = lines.filter((l) => /provisioning/i.test(l));
  const errorLines = lines.filter((l) => /level=(error|crit)/.test(l));
  // Only dashboard and datasource provisioning is this change's concern. Grafana also
  // logs an error for each provisioning subdirectory it expects but the repository
  // does not ship (plugins, alerting); those are printed, not hidden, and not failed on.
  const errors = errorLines.filter(
    (l) => /logger=provisioning.(dashboard|datasources)/.test(l) || /dashboard|datasource/i.test(l),
  );
  for (const line of errorLines) log(`grafana error-level line: ${line.trim()}`);
  for (const line of provisioningLines.slice(0, 12)) log(`grafana log: ${line.trim()}`);
  assert(errors.length === 0, `Grafana logged provisioning errors:\n${errors.join('\n')}`);
  log(
    `grafana log: ${lines.length} lines, ${provisioningLines.length} mention provisioning, ` +
      `${errorLines.length} error-level in total, 0 dashboard/datasource errors`,
  );
  return { panels: model.panels.length, targets: targets.length };
}

function cleanup() {
  docker(['rm', '-f', '-v', names.grafana, names.prometheus], { allowFailure: true });
  docker(['network', 'rm', names.network], { allowFailure: true });
  const containers = docker(
    ['ps', '-a', '--filter', `name=${names.network}`, '--format', '{{.Names}}'],
    {
      allowFailure: true,
    },
  ).stdout.trim();
  const networks = docker(
    ['network', 'ls', '--filter', `name=${names.network}`, '--format', '{{.Name}}'],
    {
      allowFailure: true,
    },
  ).stdout.trim();
  log(`cleanup: containers left=${containers || 'none'} networks left=${networks || 'none'}`);
  return containers === '' && networks === '';
}

let exitCode = 0;
try {
  const { panels, targets } = await run();
  log(`PASS: ${panels} panels, ${targets} queries accepted by Prometheus and Grafana`);
} catch (error) {
  exitCode = 1;
  console.error(`[dashboard-live] FAIL: ${error.message}`);
  const logs = spawnSync('docker', ['logs', '--tail', '40', names.grafana], { encoding: 'utf8' });
  if (logs.status === 0)
    console.error(`[dashboard-live] grafana log tail:\n${logs.stdout}${logs.stderr}`);
} finally {
  if (!cleanup()) exitCode = 1;
}
process.exit(exitCode);
