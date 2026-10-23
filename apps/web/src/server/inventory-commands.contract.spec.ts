/**
 * @jest-environment node
 */
import ts from 'typescript';

import {
  AMOUNT_FIELD,
  CONSIGNEE_PATTERN,
  INVENTORY_REFUSAL_TEXT,
  MAX_CARRIER_NAME_LENGTH,
  MAX_CARRIER_REFERENCE_LENGTH,
  MAX_SHIPMENT_LEGS,
  MAX_WAREHOUSE_NAME_LENGTH,
  ORDER_REFERENCE_PATTERN,
  PRODUCT_ID_PATTERN,
  SOURCE_REFERENCE_PATTERN,
  STOCK_ITEM_ID_PATTERN,
  parseInventoryForm,
  type InventoryCommand,
} from '@/lib/inventory-commands';
import { MAX_STOCK_QUANTITY } from '@/lib/inventory-fields';
import {
  collect,
  decoratorOf,
  handlerOf,
  literalsOf,
  parseSource,
  readSource,
  squash,
  topLevelConst,
} from '@/test/service-source';

import { webServerEnv } from './env';
import {
  INVENTORY_DETAIL_CODE_TEXT,
  SHIPMENT_MOVE_FROM,
  inventoryFieldMapping,
  inventoryRequestOf,
  type InventoryRequest,
} from './inventory-commands';
import { mapProblemToFields } from './write';

/**
 * What the inventory write screens depend on, pinned to inventory-service's
 * source and to its published OpenAPI document (`docs/api/inventory-service.openapi.json`)
 * — the technique of `returns.contract.spec.ts`: A-02 forbids importing
 * `services/*\/src`, so the portal keeps copies and this test fails the moment
 * a copy and its original disagree. The reader refuses anything it cannot read
 * literally rather than skipping it.
 */

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const SERVICE = ['services', 'inventory-service', 'src'] as const;
const warehouseController = parseSource(
  readSource(...SERVICE, 'warehouse', 'warehouse.controller.ts'),
);
const stockController = parseSource(readSource(...SERVICE, 'stock', 'stock.controller.ts'));
const shipmentController = parseSource(
  readSource(...SERVICE, 'shipment', 'shipment.controller.ts'),
);
const shipmentDto = parseSource(readSource(...SERVICE, 'shipment', 'dto.ts'));
const sharedDto = parseSource(readSource(...SERVICE, 'shared', 'dto.ts'));
const refusal = parseSource(readSource(...SERVICE, 'shared', 'refusal.ts'));
const machine = parseSource(readSource(...SERVICE, 'shipment', 'shipment.state-machine.ts'));
const accessText = readSource(...SERVICE, 'access', 'access.ts');
const serviceEnv = readSource(...SERVICE, 'config', 'env.ts');
const routes = readSource('services', 'api-gateway', 'src', 'config', 'routes.ts');
const openapi = JSON.parse(readSource('docs', 'api', 'inventory-service.openapi.json')) as {
  paths: Record<string, Record<string, Operation>>;
};

interface Schema {
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  enum?: string[];
}
interface Operation {
  parameters?: { name: string; in: string; required?: boolean }[];
  requestBody?: { content: { 'application/json': { schema: Schema } } };
  responses: Record<string, { description: string; content?: unknown }>;
}

const sorted = (values: readonly string[]) => [...values].sort();
const ULID = '01HZZZZZZZZZZZZZZZZZZZZZZZ';
const WAREHOUSE = `WHS_${ULID}`;

/** Each command, the operation it posts to, and a request the portal would send. */
const COMMANDS: readonly {
  readonly command: InventoryCommand;
  readonly path: string;
  readonly operationPath: string;
  readonly request: () => InventoryRequest;
}[] = [
  {
    command: 'CREATE_WAREHOUSE',
    path: '/v1/warehouses',
    operationPath: '/v1/warehouses',
    request: () =>
      requestOf('CREATE_WAREHOUSE', null, { name: 'x', latitude: '35.7', longitude: '51.4' }),
  },
  {
    command: 'RECEIVE_STOCK',
    path: '/v1/stock/receipts',
    operationPath: '/v1/stock/receipts',
    request: () =>
      requestOf('RECEIVE_STOCK', WAREHOUSE, {
        productId: `PRD_${ULID}`,
        quantity: '5',
        sourceReference: `PO_${ULID}`,
      }),
  },
  {
    command: 'ADJUST_STOCK',
    path: '/v1/stock/adjustments',
    operationPath: '/v1/stock/adjustments',
    request: () =>
      requestOf('ADJUST_STOCK', WAREHOUSE, {
        stockItemId: `SKI_${ULID}`,
        direction: 'DECREASE',
        [AMOUNT_FIELD]: '5',
        sourceReference: `ADJ_${ULID}`,
      }),
  },
  {
    command: 'CREATE_SHIPMENT',
    path: '/v1/shipments',
    operationPath: '/v1/shipments',
    request: () =>
      requestOf('CREATE_SHIPMENT', WAREHOUSE, {
        consigneeOrganizationId: `ORG_${ULID}`,
        orderReference: `ORD_${ULID}`,
        'leg.0.carrierName': 'x',
        'leg.0.carrierReference': 'WB-1',
      }),
  },
  {
    command: 'DISPATCH_SHIPMENT',
    path: `/v1/shipments/SHP_${ULID}/dispatch`,
    operationPath: '/v1/shipments/{id}/dispatch',
    request: () => moveRequest('DISPATCH_SHIPMENT'),
  },
  {
    command: 'DELIVER_SHIPMENT',
    path: `/v1/shipments/SHP_${ULID}/deliver`,
    operationPath: '/v1/shipments/{id}/deliver',
    request: () => moveRequest('DELIVER_SHIPMENT'),
  },
];

function requestOf(
  command: InventoryCommand,
  targetId: string | null,
  values: Record<string, string>,
): InventoryRequest {
  const parsed = parseInventoryForm(command, values);
  if (!parsed.ok) throw new Error(`the sample form for ${command} is refused by the portal`);
  const request = inventoryRequestOf(command, targetId, parsed.body, null);
  if (!request) throw new Error(`no request for ${command}`);
  return request;
}

function moveRequest(command: InventoryCommand): InventoryRequest {
  const request = inventoryRequestOf(command, `SHP_${ULID}`, null, 2);
  if (!request) throw new Error(`no request for ${command}`);
  return request;
}

const operationOf = (operationPath: string): Operation => {
  const operation = openapi.paths[operationPath]?.post;
  if (!operation) throw new Error(`no POST ${operationPath} in the OpenAPI document`);
  return operation;
};

describe('the six commands exist, as the portal posts them', () => {
  it.each(COMMANDS)('$command → POST $operationPath', ({ path, operationPath, request }) => {
    const operation = operationOf(operationPath);
    expect(request().path).toBe(path);
    // The gateway refuses an unsafe method without a key; the service demands it too.
    expect(operation.parameters).toContainEqual(
      expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
    );
  });

  it('every one is a platform person’s command: @RequirePlatformUserId, a required key, and an idempotent execute', () => {
    const handlers: readonly [ts.SourceFile, string][] = [
      [warehouseController, 'create'],
      [stockController, 'receive'],
      [stockController, 'adjust'],
      [shipmentController, 'create'],
      [shipmentController, 'dispatch'],
      [shipmentController, 'deliver'],
    ];
    for (const [controller, method] of handlers) {
      expect(decoratorOf(controller, method, 'RequirePlatformUserId')).toBeDefined();
      const body = handlerOf(controller, method).getText();
      expect(body).toContain('requiredIdempotencyKey(idempotencyKey)');
      expect(body).toContain('this.idempotency.execute');
    }
  });

  it('the gateway demands the key on all three prefixes', () => {
    for (const prefix of ['warehouses', 'stock', 'shipments']) {
      expect(squash(routes)).toContain(
        `{prefix:'${prefix}',service:'inventory',requiresIdempotencyKey:true}`,
      );
    }
  });

  it('there is no command to edit or retire a warehouse, to approve an adjustment or to give it a reason', () => {
    // If one appears, the screens must grow it: this spec fails first.
    const warehousePaths = Object.keys(openapi.paths).filter((path) =>
      path.startsWith('/v1/warehouses'),
    );
    expect(warehousePaths.sort()).toEqual(['/v1/warehouses', '/v1/warehouses/{id}']);
    expect(Object.keys(openapi.paths['/v1/warehouses/{id}']!)).toEqual(['get']);
    expect(Object.keys(openapi.paths['/v1/stock/adjustments']!)).toEqual(['post']);
    const adjust =
      operationOf('/v1/stock/adjustments').requestBody!.content['application/json'].schema;
    expect(sorted(Object.keys(adjust.properties!))).toEqual(
      sorted(['stockItemId', 'quantityDelta', 'sourceReference']),
    );
    expect(Object.keys(openapi.paths).filter((path) => /approv/i.test(path))).toEqual([]);
  });
});

describe('the bodies', () => {
  it.each(COMMANDS)(
    '$command sends only fields the strict schema has, and all it requires',
    ({ operationPath, request }) => {
      const schema = operationOf(operationPath).requestBody!.content['application/json'].schema;
      const body = request().body;
      expect(schema.additionalProperties).toBe(false);
      for (const key of Object.keys(body)) expect(Object.keys(schema.properties!)).toContain(key);
      for (const key of schema.required ?? []) expect(Object.keys(body)).toContain(key);
    },
  );

  it('a new warehouse never names an organization: the owner is the one the request acts for', () => {
    const body = COMMANDS[0]!.request().body;
    expect(body).not.toHaveProperty('organizationId');
    expect(
      operationOf('/v1/warehouses').requestBody!.content['application/json'].schema.properties,
    ).toHaveProperty('organizationId');
  });

  it('the limits are the service’s', () => {
    expect(MAX_WAREHOUSE_NAME_LENGTH).toBe(
      operationOf('/v1/warehouses').requestBody!.content['application/json'].schema.properties!
        .name!.maxLength,
    );
    const shipment =
      operationOf('/v1/shipments').requestBody!.content['application/json'].schema.properties!;
    expect(shipment.legs!.maxItems).toBe(MAX_SHIPMENT_LEGS);
    expect(shipment.legs!.minItems).toBe(1);
    expect(shipment.legs!.items!.properties!.carrierName!.maxLength).toBe(MAX_CARRIER_NAME_LENGTH);
    expect(shipment.legs!.items!.properties!.carrierReference!.maxLength).toBe(
      MAX_CARRIER_REFERENCE_LENGTH,
    );
    expect(squash(topLevelConst(shipmentDto, 'MAX_SHIPMENT_LEGS').getText())).toBe(
      String(MAX_SHIPMENT_LEGS),
    );
    const receipt =
      operationOf('/v1/stock/receipts').requestBody!.content['application/json'].schema.properties!;
    expect(receipt.quantity!.maximum).toBe(MAX_STOCK_QUANTITY);
    expect(receipt.quantity!.minimum).toBe(1);
    const adjustment =
      operationOf('/v1/stock/adjustments').requestBody!.content['application/json'].schema
        .properties!;
    expect(adjustment.quantityDelta!.maximum).toBe(MAX_STOCK_QUANTITY);
    expect(adjustment.quantityDelta!.minimum).toBe(-MAX_STOCK_QUANTITY);
    expect(squash(topLevelConst(sharedDto, 'MAX_QUANTITY').getText())).toBe(
      String(MAX_STOCK_QUANTITY).replace(/(\d)(?=(\d{3})+$)/g, '$1_'),
    );
  });

  it('the identifier patterns are the service’s', () => {
    const properties = {
      receipt:
        operationOf('/v1/stock/receipts').requestBody!.content['application/json'].schema
          .properties!,
      adjustment:
        operationOf('/v1/stock/adjustments').requestBody!.content['application/json'].schema
          .properties!,
      shipment:
        operationOf('/v1/shipments').requestBody!.content['application/json'].schema.properties!,
    };
    expect(PRODUCT_ID_PATTERN.source).toBe(properties.receipt.productId!.pattern);
    expect(SOURCE_REFERENCE_PATTERN.source).toBe(properties.receipt.sourceReference!.pattern);
    expect(SOURCE_REFERENCE_PATTERN.source).toBe(properties.adjustment.sourceReference!.pattern);
    expect(STOCK_ITEM_ID_PATTERN.source).toBe(properties.adjustment.stockItemId!.pattern);
    expect(CONSIGNEE_PATTERN.source).toBe(properties.shipment.consigneeOrganizationId!.pattern);
    expect(ORDER_REFERENCE_PATTERN.source).toBe(properties.shipment.orderReference!.pattern);
  });
});

describe('who may do what', () => {
  it('operators are configured, ORGANIZATION_ADMIN by default, and the portal’s default is the same', () => {
    expect(squash(serviceEnv)).toContain(
      "INVENTORY_OPERATOR_ROLES:z.string().default('ORGANIZATION_ADMIN')",
    );
    expect(webServerEnv().WEB_INVENTORY_ROLES).toEqual(['ORGANIZATION_ADMIN']);
  });

  it('the oversight role and the platform administrator are refused whatever the configuration says', () => {
    const access = parseSource(accessText);
    expect(literalsOf(topLevelConst(access, 'OVERSIGHT_ROLE').getText())).toEqual(['AUDITOR']);
    expect(literalsOf(topLevelConst(access, 'PLATFORM_ROLE').getText())).toEqual(['SYSTEM_ADMIN']);
    const operator = collect(access, ts.isMethodDeclaration).find(
      (node) => node.name.getText() === 'assertOperator',
    )!;
    expect(operator.getText()).toContain('this.assertPerson()');
    expect(operator.getText()).toContain('this.assertHolds(this.operators)');
    expect(accessText).toContain('context.roles.includes(OVERSIGHT_ROLE)');
    expect(accessText).toContain('context.roles.includes(PLATFORM_ROLE)');
  });

  it('only an operator of the origin warehouse’s owner moves a shipment — in the code that moves it', () => {
    const service = parseSource(readSource(...SERVICE, 'shipment', 'shipment.service.ts'));
    const method = (name: string) =>
      collect(service, ts.isMethodDeclaration).find((node) => node.name.getText() === name)!;
    // Both moves go through `move`, which asks for an operator first and reads
    // the row only under the acting organization.
    expect(squash(method('dispatch').getText())).toContain("this.move('DISPATCHED'");
    expect(squash(method('deliver').getText())).toContain("this.move('DELIVERED'");
    const move = squash(method('move').getText()) ?? '';
    expect(move.indexOf('this.access.assertOperator()')).toBeGreaterThan(-1);
    expect(move.indexOf('this.access.assertOperator()')).toBeLessThan(
      move.indexOf('this.shipments.lock('),
    );
    expect(move).toContain('this.shipments.lock(tx,acting.organizationId,id)');
    expect(move).toContain('if(!locked)throwawaitthis.notMovable(tx,acting.organizationId,id)');
    // The lock matches the shipment's own (origin) organization, nothing else.
    const lock = squash(
      collect(
        parseSource(readSource(...SERVICE, 'shipment', 'shipment.repository.ts')),
        ts.isMethodDeclaration,
      )
        .find((node) => node.name.getText() === 'lock')!
        .getText(),
    );
    expect(lock).toContain('WHERE"organization_id"=${organizationId}AND"id"=${id}FORUPDATE');
    expect(lock).not.toContain('consignee');
    // A consignee that may read the shipment is refused (403), anybody else sees nothing (404);
    // neither is a move.
    const refused = squash(method('notMovable').getText());
    expect(refused).toContain('this.access.readsAsConsignee()');
    expect(refused).toContain('{organizationId,asOrigin:false,asConsignee:true}');
    expect(refused).toContain('returnRastaError.forbidden(');
    expect(refused).toContain("returnRastaError.notFound('Shipment',id)");
    expect(refused).not.toContain('advance(');
    // The documented answers the portal says it with are the same.
    expect(shipmentController.getText()).toContain('not the consignee (Q-114)');
  });

  it('a shipment moves from exactly the statuses the portal offers each move in', () => {
    const table = collect(
      topLevelConst(machine, 'SHIPMENT_TRANSITIONS'),
      ts.isPropertyAssignment,
    ).map((property) => ({
      from: property.name.getText(),
      to: literalsOf(property.initializer.getText()),
    }));
    const fromFor = (to: string) =>
      table.filter((row) => row.to.includes(to)).map((row) => row.from);
    expect(fromFor('DISPATCHED')).toEqual([SHIPMENT_MOVE_FROM.DISPATCH_SHIPMENT]);
    expect(fromFor('DELIVERED')).toEqual([SHIPMENT_MOVE_FROM.DELIVER_SHIPMENT]);
    const dispatch = handlerOf(shipmentController, 'dispatch').getText();
    const deliver = handlerOf(shipmentController, 'deliver').getText();
    expect(dispatch).toContain('this.shipments.dispatch(id, dto');
    expect(deliver).toContain('this.shipments.deliver(id, dto');
  });
});

describe('the refusals', () => {
  /** `REFUSAL_REASONS`: area → reason → status. */
  function reasonsOf(area: string): Map<string, string> {
    const property = collect(
      topLevelConst(refusal, 'REFUSAL_REASONS'),
      ts.isPropertyAssignment,
    ).find((node) => node.name.getText() === area)!;
    const out = new Map<string, string>();
    for (const inner of collect(property.initializer, ts.isPropertyAssignment)) {
      out.set(inner.name.getText(), inner.initializer.getText());
    }
    return out;
  }

  it('says every closed reason of the stock and shipment areas in fixed words, with the status it rides on', () => {
    const stock = reasonsOf('stock');
    const shipment = reasonsOf('shipment');
    expect(sorted([...stock.keys(), ...shipment.keys()])).toEqual(
      sorted(Object.keys(INVENTORY_DETAIL_CODE_TEXT)),
    );
    expect([...stock.values(), ...shipment.values()].sort()).toEqual(['409', '409', '422', '422']);
    for (const text of Object.values(INVENTORY_DETAIL_CODE_TEXT)) expect(text).toMatch(/\S/);
  });

  it('every closed reason the OpenAPI document names for these routes is said, or belongs to a reservation', () => {
    const reservation = [...reasonsOf('reservation').keys()];
    for (const { operationPath } of COMMANDS) {
      const operation = operationOf(operationPath);
      for (const status of ['409', '422']) {
        const described = operation.responses[status]?.description ?? '';
        const tokens = new Set(described.match(/\b[A-Z][A-Z_]{5,}\b/g) ?? []);
        for (const token of tokens) {
          const known =
            token in INVENTORY_DETAIL_CODE_TEXT ||
            reservation.includes(token) ||
            [
              'ACTIVE',
              'CONFLICT',
              'IDEMPOTENCY_KEY_REUSED',
              'INVALID_STATE_TRANSITION',
              'INVENTORY_LOCK_TIMEOUT_MS',
              'OPTIMISTIC_LOCK_FAILED',
              'BUSINESS_RULE_VIOLATION',
            ].includes(token);
          expect([operationPath, status, token, known]).toEqual([
            operationPath,
            status,
            token,
            true,
          ]);
        }
      }
    }
  });

  it('says each platform code of the documented 400, 409 and 422 answers in fixed words, never the sentence', () => {
    const adjustment = inventoryFieldMapping('ADJUST_STOCK', null);
    const say = (code: string, message: string, detail?: string) =>
      mapProblemToFields(
        {
          code,
          message,
          ...(detail ? { details: [{ path: 'stock', code: detail, message }] } : {}),
        },
        adjustment,
      );
    const cases: readonly [string, string | undefined, string][] = [
      ['VALIDATION_FAILED', undefined, INVENTORY_REFUSAL_TEXT.VALIDATION],
      ['IDEMPOTENCY_KEY_REUSED', undefined, INVENTORY_REFUSAL_TEXT.KEY_REUSED],
      ['CONFLICT', undefined, INVENTORY_REFUSAL_TEXT.ALREADY_FILED],
      ['OPTIMISTIC_LOCK_FAILED', undefined, INVENTORY_REFUSAL_TEXT.CHANGED],
      ['INVALID_STATE_TRANSITION', undefined, INVENTORY_REFUSAL_TEXT.WRONG_STATE],
      ['BUSINESS_RULE_VIOLATION', undefined, INVENTORY_REFUSAL_TEXT.OTHER_RULE],
      [
        'BUSINESS_RULE_VIOLATION',
        'ON_HAND_WOULD_BE_NEGATIVE',
        INVENTORY_REFUSAL_TEXT.ON_HAND_WOULD_BE_NEGATIVE,
      ],
      [
        'BUSINESS_RULE_VIOLATION',
        'QUANTITY_OUT_OF_RANGE',
        INVENTORY_REFUSAL_TEXT.QUANTITY_OUT_OF_RANGE,
      ],
      [
        'INVALID_STATE_TRANSITION',
        'SHIPMENT_NOT_CREATED',
        INVENTORY_REFUSAL_TEXT.SHIPMENT_NOT_CREATED,
      ],
      [
        'INVALID_STATE_TRANSITION',
        'SHIPMENT_NOT_DISPATCHED',
        INVENTORY_REFUSAL_TEXT.SHIPMENT_NOT_DISPATCHED,
      ],
      ['A_CODE_NOBODY_DOCUMENTED', undefined, INVENTORY_REFUSAL_TEXT.FALLBACK],
    ];
    for (const [code, detail, text] of cases) {
      const said = say(code, 'An English sentence from the service', detail);
      expect(JSON.stringify(said)).toContain(text);
      expect(JSON.stringify(said)).not.toContain('English sentence');
    }
  });

  it('the 422 of a stock command names its reasons under the `stock` area, the 409 of a move under `shipment`', () => {
    const detailEnum = (operationPath: string, status: string): string[] => {
      const content = operationOf(operationPath).responses[status]!.content as {
        'application/json': { schema: Schema & { properties: { details: Schema } } };
      };
      return content['application/json'].schema.properties.details.items!.properties!.code!.enum!;
    };
    expect(sorted(detailEnum('/v1/stock/adjustments', '422'))).toEqual(
      sorted(['ON_HAND_WOULD_BE_NEGATIVE', 'QUANTITY_OUT_OF_RANGE']),
    );
    expect(sorted(detailEnum('/v1/shipments/{id}/dispatch', '409'))).toEqual(
      expect.arrayContaining(['SHIPMENT_NOT_CREATED', 'SHIPMENT_NOT_DISPATCHED']),
    );
  });
});
