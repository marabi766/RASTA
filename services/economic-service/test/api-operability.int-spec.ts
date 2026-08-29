import request from 'supertest';
import type { Server } from 'node:http';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { admin, apiTenant, startApi, type ApiHarness } from './api-helpers';
import { enrichOpenApiDocument } from '../src/openapi/document';
import { LedgerBalanceAudit } from '../src/wallet/balance-audit';
import { WalletRepository } from '../src/wallet/wallet.repository';
import { cleanup, id } from './helpers';
import { runUnscoped } from '@rasta/nest-common';

/**
 * The things that are true of the service rather than of a request: its
 * probes, its published contract, and the reconciliation that watches the
 * wallets.
 *
 * Each of these is a definition-of-done item in AGENTS.md § 7 — "API
 * Contract", "Telemetry", "Logging" — that had no test. An OpenAPI document
 * that fails to generate breaks the contract every client is written against,
 * and would previously have been discovered by a person opening `/docs`.
 */
describe('operability', () => {
  let harness: ApiHarness;
  let http: Server;

  const org = apiTenant('OPS');

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [org]);
    await harness.close();
  });

  // -------------------------------------------------------------------------
  // Probes
  // -------------------------------------------------------------------------

  it('answers liveness without touching a dependency', async () => {
    const response = await request(http).get('/health/live').expect(200);

    expect(response.body.status).toBe('ok');
    expect(response.body.service).toBe('economic-service');
    expect(typeof response.body.uptimeSeconds).toBe('number');
  });

  it('reports readiness with the database as the only hard dependency', async () => {
    const response = await request(http).get('/health/ready').expect(200);

    expect(response.body.status).toBe('ok');
    expect(response.body.checks.database).toBe(true);
    // Kafka being down delays publication but loses no financial state — the
    // outbox retains what has not gone out (ADR-021). Degraded, not unready,
    // and the response says which.
    expect(Array.isArray(response.body.degraded)).toBe(true);
  });

  it('answers the startup probe and reports its build', async () => {
    await request(http).get('/health/startup').expect(200);

    const version = await request(http).get('/health/version').expect(200);
    expect(version.body.service).toBe('economic-service');
    expect(version.body.node).toBe(process.version);
  });

  it('exposes Prometheus metrics in the text exposition format', async () => {
    const response = await request(http).get('/metrics').expect(200);

    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.text).toContain('# HELP');
  });

  it('leaves the probes open and everything else closed', async () => {
    // The probes are the only `@Public` endpoints in this service, and they
    // carry no business data. Everything else is closed by default
    // (AGENTS.md S-02), which is what this pair asserts together.
    await request(http).get('/health/live').expect(200);
    await request(http).get('/v1/wallets/me').expect(401);
  });

  // -------------------------------------------------------------------------
  // The published contract
  // -------------------------------------------------------------------------

  it('generates an OpenAPI document with the payload shapes filled in from the Zod schemas', () => {
    // Nest derives paths, methods and security from the decorators but cannot
    // see a Zod schema, so `enrichOpenApiDocument` fills the bodies in from the
    // very schemas the service validates with — one definition rather than a
    // decorated class and a hand-written document that drift.
    const document = SwaggerModule.createDocument(
      harness.app,
      new DocumentBuilder()
        .setTitle('Rasta — economic-service')
        .setVersion('0.0.0')
        .addBearerAuth()
        .build(),
    );

    const enriched = enrichOpenApiDocument(document);
    const paths = Object.keys(enriched.paths ?? {});

    for (const expected of [
      '/v1/wallets/me',
      '/v1/wallets/{id}/top-up',
      '/v1/transactions',
      '/v1/settlements',
      '/v1/ledger/trial-balance',
      '/v1/commissions/rules',
      '/v1/rewards/me',
    ]) {
      expect(paths).toContain(expected);
    }

    const createTransaction = enriched.paths?.['/v1/transactions']?.post;
    expect(createTransaction).toBeDefined();
    // The request body is what a client is written against; without it the
    // document describes a URL and nothing else.
    expect(createTransaction?.requestBody).toBeDefined();

    // Money is a string on the wire, and the document has to say so — a client
    // generated against `number` truncates a rial figure in its own JSON
    // parser, where no validation of ours can see it (ADR-022).
    const serialised = JSON.stringify(enriched);
    expect(serialised).toContain('grossAmountMinor');
    expect(serialised).not.toContain('"grossAmountMinor":{"type":"number"');
  });

  // -------------------------------------------------------------------------
  // Reconciliation
  // -------------------------------------------------------------------------

  it('finds no deviation for wallets the platform itself wrote', async () => {
    const wallet = await request(http)
      .get('/v1/wallets/me')
      .set('authorization', `Bearer ${admin(org)}`)
      .expect(200);

    await request(http)
      .post(`/v1/wallets/${wallet.body.id}/top-up`)
      .set('authorization', `Bearer ${admin(org)}`)
      .set('idempotency-key', id('api-audit-fund'))
      .send({ amountMinor: '400000' })
      .expect(201);

    const audit = harness.app.get(LedgerBalanceAudit);
    const deviations = await audit.run();

    expect(deviations.find((row) => row.walletId === wallet.body.id)).toBeUndefined();
  });

  it('reports a wallet that disagrees with its ledger, and never repairs it', async () => {
    const wallet = await request(http)
      .get('/v1/wallets/me')
      .set('authorization', `Bearer ${admin(org)}`)
      .expect(200);

    // Forced divergence, written straight to the row — the one thing no code
    // path in this service can do. The point is what the audit does when it
    // happens anyway, which is the only state this class exists for.
    await runUnscoped('the reconciliation suite forces a divergence it then detects', () =>
      harness.prisma.client.$executeRawUnsafe(
        `UPDATE wallet
            SET available_balance_minor = available_balance_minor - 1,
                ledger_balance_minor    = ledger_balance_minor - 1
          WHERE id = $1`,
        wallet.body.id,
      ),
    );

    const audit = harness.app.get(LedgerBalanceAudit);
    const deviations = await audit.run();

    const found = deviations.find((row) => row.walletId === wallet.body.id);
    expect(found).toBeDefined();
    expect(found?.kind).toBe('AVAILABLE_VS_LEDGER');

    // And the row is exactly as the audit found it. A reconciliation that
    // corrected the wallet would destroy the evidence of whatever caused the
    // divergence and make a data-integrity incident look like a healthy
    // system (docs/10 § 10.3).
    const repository = harness.app.get(WalletRepository);
    const after = await runUnscoped('the suite reads back the row it corrupted', () =>
      harness.prisma.client.wallet.findUnique({ where: { id: wallet.body.id } }),
    );
    expect(after?.availableBalanceMinor).toBe(BigInt(wallet.body.availableBalanceMinor) - 1n);
    expect(repository).toBeDefined();

    // Restored, so the suite leaves the database as it found it.
    await runUnscoped('the reconciliation suite undoes the divergence it forced', () =>
      harness.prisma.client.$executeRawUnsafe(
        `UPDATE wallet
            SET available_balance_minor = available_balance_minor + 1,
                ledger_balance_minor    = ledger_balance_minor + 1
          WHERE id = $1`,
        wallet.body.id,
      ),
    );
  });
});
