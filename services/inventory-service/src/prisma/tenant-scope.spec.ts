import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TENANT_SCOPED_MODELS, TENANT_SCOPE_EXEMPT_MODELS } from './prisma.service';

/**
 * Proves the tenant guard is configured for **this** service's schema.
 *
 * document-service learned why this test has to exist: its `TENANT_SCOPED_MODELS` held
 * marketplace-service's model names, none of which existed in its database. The guard passes
 * any model it does not recognise straight through, so it scoped nothing while looking
 * installed. The answer is therefore derived from `schema.prisma`: every model with an
 * `organizationId` field is guarded, minus the exemptions the service names and justifies.
 */

const SCHEMA = readFileSync(join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');
const MIGRATION = readFileSync(
  join(
    __dirname,
    '..',
    '..',
    'prisma',
    'migrations',
    '20261013120000_init_inventory',
    'migration.sql',
  ),
  'utf8',
);
const SHIPMENTS_MIGRATION = readFileSync(
  join(__dirname, '..', '..', 'prisma', 'migrations', '20261014120000_shipments', 'migration.sql'),
  'utf8',
);

/** Every `model X { ... }` block in the schema, as name → body. */
function models(schema: string): Map<string, string> {
  const found = new Map<string, string>();
  const pattern = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;

  for (const match of schema.matchAll(pattern)) {
    found.set(match[1] as string, match[2] as string);
  }
  return found;
}

function modelsWithTenantColumn(schema: string): string[] {
  return [...models(schema)]
    .filter(([, body]) => /^\s*organizationId\s/m.test(body))
    .map(([name]) => name)
    .sort();
}

describe('the tenant guard covers this service schema', () => {
  it('finds the models it is meant to be comparing against', () => {
    // Guards the guard: a regex that stopped matching would make every assertion below
    // trivially true against an empty set.
    expect([...models(SCHEMA).keys()]).toEqual(
      expect.arrayContaining(['Warehouse', 'StockItem', 'OutboxMessage', 'OutboxStreamSequence']),
    );
  });

  it('scopes every model that carries an organization, and no others', () => {
    const shouldBeScoped = modelsWithTenantColumn(SCHEMA).filter(
      (model) => !(TENANT_SCOPE_EXEMPT_MODELS as readonly string[]).includes(model),
    );

    expect([...TENANT_SCOPED_MODELS].sort()).toEqual(shouldBeScoped);
  });

  it('names no model this schema does not define', () => {
    const defined = new Set(models(SCHEMA).keys());
    expect([...TENANT_SCOPED_MODELS].filter((model) => !defined.has(model))).toEqual([]);
  });

  it('exempts the outbox, and says so rather than omitting it quietly', () => {
    expect(TENANT_SCOPE_EXEMPT_MODELS).toContain('OutboxMessage');
    expect(modelsWithTenantColumn(SCHEMA)).toContain('OutboxMessage');
  });
});

describe('the schema keeps history from being erased', () => {
  it('uses no cascading delete anywhere', () => {
    expect(SCHEMA).not.toMatch(/onDelete:\s*Cascade/);
    expect(MIGRATION).not.toMatch(/ON DELETE CASCADE/i);
    expect(SHIPMENTS_MIGRATION).not.toMatch(/ON DELETE CASCADE/i);
  });

  it('guards shipments against deletion and their legs and tracking as append-only (PR 2)', () => {
    for (const trigger of [
      'tg_shipment_guard',
      'tg_shipment_no_truncate',
      'tg_shipment_history_check',
      'tg_shipment_leg_guard',
      'tg_shipment_leg_no_truncate',
      'tg_tracking_event_guard',
      'tg_tracking_event_no_truncate',
    ]) {
      expect([trigger, SHIPMENTS_MIGRATION.includes(`TRIGGER "${trigger}"`)]).toEqual([
        trigger,
        true,
      ]);
    }
  });

  it('guards the ledger as append-only and every balance-bearing table against deletion', () => {
    for (const trigger of [
      'tg_stock_movement_append_only',
      'tg_stock_movement_no_truncate',
      'tg_stock_item_guard',
      'tg_stock_item_no_truncate',
      'tg_stock_reservation_guard',
      'tg_stock_reservation_no_truncate',
      'tg_warehouse_guard',
      'tg_warehouse_no_truncate',
    ]) {
      expect([trigger, MIGRATION.includes(`CREATE TRIGGER "${trigger}"`)]).toEqual([trigger, true]);
    }
  });
});

describe('the schema models nothing COM-006 has not decided', () => {
  it('has warehouses, stock items, movements, reservations (PR 1), shipments, legs and tracking (PR 2) and the idempotency store', () => {
    // Each PR adds its models here, so an unplanned one still fails this test.
    const names = [...models(SCHEMA).keys()].filter(
      (name) => !['OutboxMessage', 'OutboxStreamSequence'].includes(name),
    );
    expect(names).toEqual([
      'Warehouse',
      'StockItem',
      'StockMovement',
      'StockReservation',
      'Shipment',
      'ShipmentLeg',
      'TrackingEvent',
      'ReturnShipment',
      'ReturnShipmentLine',
      'ReturnTrackingEvent',
      'IdempotencyKey',
    ]);
  });

  it('keeps no consumer bookkeeping: nothing is consumed yet (ADR-056 § 7, ADR-032)', () => {
    expect(SCHEMA).not.toMatch(/ProcessedEvent|processed_event/);
  });

  it('counts stock in integers, with no float and no unit-of-measure column (Q-105)', () => {
    expect(SCHEMA).not.toMatch(/\b(Float|Decimal)\b/);
    expect(SCHEMA).not.toMatch(/\bunit\w*\s/i);
  });

  it('keeps the three balance CHECKs of ADR-056 § 3 and a generated available quantity', () => {
    expect(MIGRATION).toMatch(/CHECK \("on_hand_quantity" >= 0\)/);
    expect(MIGRATION).toMatch(/CHECK \("reserved_quantity" >= 0\)/);
    expect(MIGRATION).toMatch(/CHECK \("reserved_quantity" <= "on_hand_quantity"\)/);
    expect(MIGRATION).toMatch(
      /"available_quantity" INTEGER GENERATED ALWAYS AS \("on_hand_quantity" - "reserved_quantity"\) STORED/,
    );
  });

  it('is born timestamptz: no plain timestamp column (D-048)', () => {
    const plain = [...SCHEMA.matchAll(/^\s*(\w+)\s+DateTime\??\s*(?!.*@db\.Timestamptz).*$/gm)]
      .map((match) => match[0].trim())
      .filter((line) => !line.includes('@db.Timestamptz'));
    expect(plain).toEqual([]);
    expect(MIGRATION).not.toMatch(/TIMESTAMP\(3\)/);
    expect(SHIPMENTS_MIGRATION).not.toMatch(/TIMESTAMP\(3\)/);
  });

  it('stores no raw Idempotency-Key in a domain table (S-09)', () => {
    for (const model of ['StockMovement', 'StockReservation', 'Shipment', 'TrackingEvent']) {
      const body = models(SCHEMA).get(model) ?? '';
      expect([model, /idempotencyKey|idempotency_key/.test(body)]).toEqual([model, false]);
      expect(body).toMatch(/commandKeyHash/);
    }
  });
});
