#!/usr/bin/env node
/**
 * The API half of the live Grafana dashboard check. Not run directly:
 * `verify-grafana-dashboard-live.mjs` starts it in a short-lived `node:22-alpine`
 * container on the same Docker `--internal` network as Prometheus and Grafana,
 * with the repository mounted read-only as the working directory, and reaches
 * them only as `http://prometheus:9090` and `http://grafana:3000`. It has no
 * Docker access; the Grafana log assertions stay in the orchestrator.
 *
 * Environment (harness-only, see `PROBE_ENV`): the two alias URLs and the
 * throwaway Grafana admin password, which is never printed.
 *
 * What passing proves: Prometheus loaded the rules file; Grafana provisioned the
 * datasource with the stable UID and URL and can reach Prometheus through it;
 * the dashboard is in the `Rasta` folder with the exact UID, title, panel and
 * query count and cannot be deleted; the dashboard page is served; no app plugin
 * outside core is installed and no alert rule, contact point or policy is
 * provisioned; and every query is accepted by Prometheus directly and through
 * Grafana. With no scrape targets running, results are mostly empty — that is
 * expected, and says nothing about what the panels would show with real data.
 */
import { readFileSync } from 'node:fs';
import { EXPECTED, PATHS, collectTargets, parseRuleNames } from './check-grafana-dashboard-lib.mjs';
import { readProbeEnvironment } from './verify-grafana-dashboard-isolation-lib.mjs';

/** Fixed substitutions for Grafana interval macros, used only to submit queries to Prometheus. */
const MACROS = [
  [/\$__rate_interval\b/g, '5m'],
  [/\$__interval\b/g, '1m'],
  [/\$__range\b/g, '1h'],
];

const log = (message) => console.warn(`[dashboard-probe] ${message}`);

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

async function probe({ prometheus: prom, grafana, password }) {
  const dashboardModel = JSON.parse(readFileSync(PATHS.dashboard, 'utf8'));
  const targets = collectTargets(dashboardModel);
  const rules = parseRuleNames(readFileSync(PATHS.rules, 'utf8'));
  const authed = {
    Authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`,
  };

  await waitFor('Prometheus ready', async () => (await fetch(`${prom}/-/ready`)).ok);
  await waitFor(
    'Grafana healthy',
    async () => {
      const { status, body } = await getJson(`${grafana}/api/health`);
      return status === 200 && body.database === 'ok';
    },
    480_000,
  ); // A first boot runs every SQLite migration; on a slow Docker disk that took over two minutes.
  log(`reached ${prom} (ready) and ${grafana} (healthy) by container alias`);

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

  // The inert plugins/ and alerting/ provisioning installed and provisioned nothing.
  const apps = await getJson(`${grafana}/api/plugins?type=app`, authed);
  assert(apps.status === 200 && Array.isArray(apps.body), `plugin list returned ${apps.status}`);
  const externalApps = apps.body.filter((p) => p.signature !== 'internal');
  assert(
    externalApps.length === 0,
    `non-core app plugins present: ${externalApps.map((p) => p.id).join(', ')}`,
  );
  const alertRules = await getJson(`${grafana}/api/v1/provisioning/alert-rules`, authed);
  assert(
    alertRules.status === 200 && Array.isArray(alertRules.body) && alertRules.body.length === 0,
    `Grafana alert rules: ${alertRules.status} ${JSON.stringify(alertRules.body).slice(0, 200)}`,
  );
  const contactPoints = await getJson(`${grafana}/api/v1/provisioning/contact-points`, authed);
  assert(
    contactPoints.status === 200 && Array.isArray(contactPoints.body),
    `contact point list returned ${contactPoints.status}`,
  );
  const provisionedContactPoints = contactPoints.body.filter((c) => c.provenance);
  assert(
    provisionedContactPoints.length === 0,
    `provisioned contact points: ${provisionedContactPoints.map((c) => c.name).join(', ')}`,
  );
  const policies = await getJson(`${grafana}/api/v1/provisioning/policies`, authed);
  assert(
    policies.status === 200 && !policies.body.provenance,
    `notification policy tree is provisioned (${policies.status} ${policies.body?.provenance})`,
  );
  log(
    `plugins: ${apps.body.length} app plugin(s), none outside core ` +
      `(${apps.body.map((p) => `${p.id}:${p.signature}`).join(', ') || 'none'}); ` +
      `alerting: ${alertRules.body.length} alert rules, ${contactPoints.body.length} contact point(s) ` +
      `(${contactPoints.body.map((c) => c.name).join(', ')}), 0 provisioned; policy tree not provisioned`,
  );
  return { panels: model.panels.length, targets: targets.length };
}

try {
  const { panels, targets } = await probe(readProbeEnvironment(process.env));
  log(`PASS: ${panels} panels, ${targets} queries accepted by Prometheus and Grafana`);
} catch (error) {
  console.error(`[dashboard-probe] FAIL: ${error.message}`);
  process.exitCode = 1;
}
