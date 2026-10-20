/**
 * @jest-environment node
 */
import ts from 'typescript';

import {
  MAX_RETURN_LINES,
  MAX_RETURN_QUANTITY,
  ORDER_LINE_ID_MAX,
  PHYSICAL_RETURN_STATUSES,
  RETURN_DISPOSITIONS,
  RETURN_LIST_SIDES,
  RETURN_REASON_MAX,
  RETURN_REASON_MIN,
  RETURN_REFUSAL_TEXT,
  RETURN_SHIPMENT_STATUSES,
  RETURN_STATUSES,
} from '@/lib/return-fields';
import {
  collect,
  literalsOf,
  parseSource,
  readSource,
  rolesOf,
  squash,
  topLevelConst,
} from '@/test/service-source';

import {
  PORTAL_CANCEL_FROM,
  RETURNABLE_ORDER_STATUS,
  RETURN_CANCEL_ROLES,
  RETURN_COMMAND_FIELD_MAPPING,
  RETURN_COMMAND_FROM,
  RETURN_COMMAND_REQUESTS,
  RETURN_DECISION_ROLES,
  RETURN_READ_ROLES,
  RETURN_REQUEST_ROLES,
  returnRequestFieldMapping,
} from './returns';
import { mapProblemToFields } from './write';

/**
 * What the return screens depend on, pinned to marketplace-service's (and,
 * for the goods' side, inventory-service's) source — the technique of
 * `place-order.contract.spec.ts`: A-02 forbids importing `services/*\/src`, so
 * the portal keeps copies and this test fails the moment a copy and its
 * original disagree. The reader refuses anything it cannot read literally
 * rather than skipping it.
 */

const RETURNS = ['services', 'marketplace-service', 'src', 'returns'] as const;
const controller = parseSource(readSource(...RETURNS, 'return.controller.ts'));
const dto = parseSource(readSource(...RETURNS, 'dto.ts'));
const accessText = readSource(...RETURNS, 'return-access.ts');
const serviceText = readSource(...RETURNS, 'return.service.ts');
const service = parseSource(serviceText);
const machineText = readSource(...RETURNS, 'state-machine.ts');
const machine = parseSource(machineText);
const marketplaceAccess = parseSource(
  readSource('services', 'marketplace-service', 'src', 'access', 'access.ts'),
);
const marketplaceEnv = readSource('services', 'marketplace-service', 'src', 'config', 'env.ts');
const shipmentDto = parseSource(
  readSource('services', 'inventory-service', 'src', 'return-shipment', 'dto.ts'),
);
const dispositions = parseSource(
  readSource('packages', 'contracts', 'src', 'events', 'inventory-returns.ts'),
);
const routes = readSource('services', 'api-gateway', 'src', 'config', 'routes.ts');

const sorted = (values: readonly string[]) => [...values].sort();

describe('who may do what', () => {
  it('reads with the roles both read routes admit', () => {
    expect(sorted(rolesOf(controller, 'list'))).toEqual(sorted(RETURN_READ_ROLES));
    expect(sorted(rolesOf(controller, 'get'))).toEqual(sorted(RETURN_READ_ROLES));
  });

  it('asks, decides and withdraws with each route’s own @Roles', () => {
    expect(sorted(rolesOf(controller, 'request'))).toEqual(sorted(RETURN_REQUEST_ROLES));
    expect(sorted(rolesOf(controller, 'decide'))).toEqual(sorted(RETURN_DECISION_ROLES));
    expect(sorted(rolesOf(controller, 'cancel'))).toEqual(sorted(RETURN_CANCEL_ROLES));
  });

  it('gives the buyer the request and the withdrawal, the supplier the two decisions', () => {
    const authorisation = squash(
      topLevelConst(parseSource(accessText), 'RETURN_AUTHORISATION').getText(),
    );
    expect(authorisation).toContain('request:(order:OrderParties)=>assertBuyer(order,');
    expect(authorisation).toContain('authorize:(request:ReturnParties)=>assertSupplier(request,');
    expect(authorisation).toContain('reject:(request:ReturnParties)=>assertSupplier(request,');
    expect(authorisation).toContain('cancel:(request:ReturnParties)=>assertBuyer(request,');
  });

  it('checks the party with the buyer and supplier role sets the portal copies, no platform exemption', () => {
    expect(sorted(literalsOf(topLevelConst(marketplaceAccess, 'BUYER_ROLES').getText()))).toEqual(
      sorted(RETURN_REQUEST_ROLES),
    );
    expect(
      sorted(literalsOf(topLevelConst(marketplaceAccess, 'SUPPLIER_ROLES').getText())),
    ).toEqual(sorted(RETURN_DECISION_ROLES));
    for (const name of ['assertBuyer', 'assertSupplier']) {
      const fn = collect(marketplaceAccess, ts.isFunctionDeclaration).find(
        (node) => node.name?.text === name,
      );
      const body = fn?.getText() ?? '';
      expect(body).toContain('assertNotAuditor()');
      expect(body).not.toContain('hasPlatformScope');
    }
  });

  it('asks only of a completed order, the status the portal checks', () => {
    expect(topLevelConst(service, 'RETURNABLE_ORDER_STATUS').getText()).toBe(
      `'${RETURNABLE_ORDER_STATUS}'`,
    );
    expect(serviceText).toContain('order.status !== RETURNABLE_ORDER_STATUS || !order.completedAt');
  });

  it('moves a request from exactly the statuses the portal offers each command in', () => {
    expect(literalsOf(topLevelConst(machine, 'RETURN_STATUSES').getText())).toEqual([
      ...RETURN_STATUSES,
    ]);
    const table = collect(
      topLevelConst(machine, 'RETURN_TRANSITIONS'),
      ts.isPropertyAssignment,
    ).map((property) => ({
      from: property.name.getText(),
      to: literalsOf(property.initializer.getText()),
    }));
    const fromFor = (to: string) => table.filter((row) => row.to.includes(to)).map((r) => r.from);
    expect(sorted(fromFor('AUTHORIZED'))).toEqual(sorted(RETURN_COMMAND_FROM.AUTHORIZE));
    expect(sorted(fromFor('REJECTED'))).toEqual(sorted(RETURN_COMMAND_FROM.REJECT));
    expect(sorted(fromFor('CANCELLED'))).toEqual(sorted(RETURN_COMMAND_FROM.CANCEL));
    // Each command names the status it moves to.
    expect(serviceText).toContain("this.decide(id, 'AUTHORIZED', 'authorize'");
    expect(serviceText).toContain("this.decide(id, 'REJECTED', 'reject'");
    expect(serviceText).toContain("this.decide(id, 'CANCELLED', 'cancel'");
  });

  it('the portal withdraws from fewer statuses than the service, never more — and no authorized one', () => {
    // PR 336 review 2, PM ruling: until marketplace refuses a withdrawal once a
    // shipment exists, the portal offers none for an authorized request.
    for (const status of PORTAL_CANCEL_FROM) expect(RETURN_COMMAND_FROM.CANCEL).toContain(status);
    expect(PORTAL_CANCEL_FROM).not.toContain('AUTHORIZED');
  });
});

describe('the bodies', () => {
  const create = squash(topLevelConst(dto, 'createReturnSchema').getText()) ?? '';

  it('asks with a reason and lines only — no price, no refund amount — and is strict', () => {
    expect(create).toContain('.strict()');
    expect(create).not.toMatch(/price|amount|refund|currency/i);
    expect(create).toContain(
      `reason:plainText().min(${RETURN_REASON_MIN}).max(${RETURN_REASON_MAX})`,
    );
    expect(create).toContain(`orderLineId:z.string().trim().min(1).max(${ORDER_LINE_ID_MAX})`);
    expect(create).toContain(
      `quantity:z.number().int().positive().max(${MAX_RETURN_QUANTITY.toLocaleString('en').replace(/,/g, '_')})`,
    );
    expect(create).toContain(`.min(1).max(${MAX_RETURN_LINES})`);
    // The request's order is the path's, never the body's.
    expect(create).not.toContain('orderId');
  });

  it('decides with one of two words, and the portal sends exactly those', () => {
    expect(squash(topLevelConst(dto, 'decideReturnSchema').getText())).toBe(
      "z.object({decision:z.enum(['AUTHORIZE','REJECT'])}).strict()",
    );
    expect(RETURN_COMMAND_REQUESTS.AUTHORIZE).toEqual({
      path: 'decisions',
      body: { decision: 'AUTHORIZE' },
    });
    expect(RETURN_COMMAND_REQUESTS.REJECT).toEqual({
      path: 'decisions',
      body: { decision: 'REJECT' },
    });
  });

  it('posts to the routes the controllers declare, and the withdrawal names the status it saw', () => {
    const text = controller.getText();
    expect(squash(text)).toContain("@Controller({path:'orders/:orderId/returns',version:'1'})");
    expect(squash(text)).toContain("@Controller({path:'returns',version:'1'})");
    expect(squash(text)).toContain("@Post(':id/decisions')");
    expect(squash(text)).toContain("@Post(':id/cancellation')");
    expect(RETURN_COMMAND_REQUESTS.CANCEL.path).toBe('cancellation');
    expect(squash(text)).toContain(
      "cancel(@Param('id')id:string,@Body(zodPipe(cancelReturnSchema))dto:CancelReturnDto,@Headers('idempotency-key')idempotencyKey?:string)",
    );
    // The one field, required, a status the service cancels from — and the portal's is one of them.
    expect(squash(topLevelConst(dto, 'cancelReturnSchema').getText())).toBe(
      'cancelReturnSchema=z.object({expectedStatus:z.enum(CANCELLABLE_STATUSES)}).strict()',
    );
    expect(squash(topLevelConst(dto, 'CANCELLABLE_STATUSES').getText())).toBe(
      "CANCELLABLE_STATUSES=['REQUESTED','AUTHORIZED']asconst",
    );
    expect(RETURN_COMMAND_REQUESTS.CANCEL.body).toEqual({ expectedStatus: PORTAL_CANCEL_FROM[0] });
    expect(PORTAL_CANCEL_FROM).toEqual(['REQUESTED']);
  });

  it('lists by the side the portal asks for, and the statuses it filters on', () => {
    const list = squash(topLevelConst(dto, 'listReturnsQuerySchema').getText()) ?? '';
    expect(list).toContain("role:z.enum(['BUYER','SUPPLIER']).default('BUYER')");
    expect(list).toContain('status:z.enum(RETURN_STATUSES).optional()');
    expect(list).toContain('limit:z.coerce.number().int().min(1).max(100)');
    expect([...RETURN_LIST_SIDES]).toEqual(['BUYER', 'SUPPLIER']);
  });

  it('is reached through the gateway: returns and orders at marketplace, return shipments at inventory', () => {
    const squashed = squash(routes) ?? '';
    expect(squashed).toContain(
      "{prefix:'returns',service:'marketplace',requiresIdempotencyKey:true}",
    );
    expect(squashed).toContain(
      "{prefix:'return-shipments',service:'inventory',requiresIdempotencyKey:true}",
    );
  });
});

/** A sentence template from the source, with sample values where it has `${…}`. */
function sample(template: string): string {
  return template.replace(/\$\{([^}]+)\}/g, (_, expression: string) =>
    /Days|available|quantity/.test(expression)
      ? '7'
      : /status|from|\bto\b/.test(expression)
        ? 'REQUESTED'
        : 'RET_01J0000000000000000000000A',
  );
}

/** The first argument of every `RastaError.businessRule(...)` in a source, as written. */
function businessRules(source: ts.SourceFile): string[] {
  return collect(source, ts.isCallExpression)
    .filter((call) => call.expression.getText() === 'RastaError.businessRule')
    .map((call) => {
      const first = call.arguments[0];
      if (!first) throw new Error('a business rule with no sentence');
      if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) return first.text;
      if (ts.isTemplateExpression(first)) return first.getText().slice(1, -1);
      if (ts.isConditionalExpression(first)) {
        return [first.whenTrue, first.whenFalse]
          .map((branch) => branch.getText().slice(1, -1))
          .join('\n');
      }
      throw new Error(`a business rule sentence that is not literal: ${first.getText()}`);
    })
    .flatMap((text) => text.split('\n'));
}

describe('every refusal, in the portal’s own words', () => {
  const said = (message: string, code = 'BUSINESS_RULE_VIOLATION') =>
    mapProblemToFields({ code, message }, RETURN_COMMAND_FIELD_MAPPING).message;

  const expected: Readonly<Record<string, string>> = {
    'Returns are not open': RETURN_REFUSAL_TEXT.WINDOW_NOT_CONFIGURED,
    'return window for order': RETURN_REFUSAL_TEXT.WINDOW_ELAPSED,
    'goods are returned only from a COMPLETED order': RETURN_REFUSAL_TEXT.ORDER_NOT_COMPLETED,
    'left to return': RETURN_REFUSAL_TEXT.QUANTITY_EXCEEDS,
    'cannot change further': RETURN_REFUSAL_TEXT.WRONG_STATE,
    'cannot move from': RETURN_REFUSAL_TEXT.WRONG_STATE,
  };

  it('classifies every business rule the service and the state machine throw', () => {
    const rules = [...businessRules(service), ...businessRules(machine)];
    expect(rules.length).toBe(Object.keys(expected).length);
    for (const template of rules) {
      const key = Object.keys(expected).find((part) => template.includes(part));
      expect([template, key]).toEqual([template, expect.any(String)]);
      const text = said(sample(template));
      expect([template, text]).toEqual([template, expected[key!]]);
    }
  });

  it('never shows the sentence, and says something fixed for one it does not know', () => {
    for (const template of [...businessRules(service), ...businessRules(machine)]) {
      expect(said(sample(template))).not.toMatch(/[A-Za-z]{4,}/);
    }
    expect(said('Something new')).toBe(RETURN_REFUSAL_TEXT.OTHER_RULE);
    expect(said('Something new', 'TEAPOT')).toBe(RETURN_REFUSAL_TEXT.FALLBACK);
  });

  it('says a key already used for a request (`CONFLICT` without Retry-After) as already filed', () => {
    expect(serviceText).toContain(
      "'A return has already been requested on this order with this Idempotency-Key'",
    );
    expect(said('A return has already been requested on this order', 'CONFLICT')).toBe(
      RETURN_REFUSAL_TEXT.ALREADY_FILED,
    );
  });

  it('says a line of another order by its closed detail code', () => {
    expect(serviceText).toContain("code: 'unknown_order_line'");
    const mapping = returnRequestFieldMapping({
      reason: 'کالا معیوب رسید.',
      lines: [{ orderLineId: 'OLN_1', quantity: 1 }],
    });
    expect(
      mapProblemToFields(
        {
          code: 'VALIDATION_FAILED',
          message: 'A return names lines of its own order',
          details: [{ path: 'lines', code: 'unknown_order_line', message: 'Order line OLN_9 …' }],
        },
        mapping,
      ).message,
    ).toBe(RETURN_REFUSAL_TEXT.UNKNOWN_LINE);
  });

  it('knows the window has no default (Q-132)', () => {
    expect(squash(marketplaceEnv)).toContain(
      'MARKETPLACE_RETURN_WINDOW_DAYS:z.coerce.number().int().min(1).max(730).optional()',
    );
  });

  it('mirrors the idempotency retention’s bounds (the replay window, `return-replay.ts`)', () => {
    expect(squash(marketplaceEnv)).toContain(
      'MARKETPLACE_IDEMPOTENCY_TTL_HOURS:z.coerce.number().int().min(1).max(168).default(24)',
    );
  });
});

describe('the goods’ side (inventory-service), read only', () => {
  it('has the shipment statuses the portal labels', () => {
    expect(literalsOf(topLevelConst(shipmentDto, 'RETURN_SHIPMENT_STATES').getText())).toEqual([
      ...RETURN_SHIPMENT_STATUSES,
    ]);
  });

  it('has the dispositions the portal labels', () => {
    expect(literalsOf(topLevelConst(dispositions, 'RETURN_DISPOSITIONS').getText())).toEqual([
      ...RETURN_DISPOSITIONS,
    ]);
  });

  it('lists by return request', () => {
    const list = squash(topLevelConst(shipmentDto, 'listReturnShipmentsQuerySchema').getText());
    expect(list).toContain('returnRequestId:');
  });
});

/**
 * PR 336 review 1: the copies round 2 added — which shipment is a request's
 * goods (finding 1), when goods are moving (finding 2), which requests hold
 * units (finding 3) — pinned to the mirror and the state machine they copy.
 */
describe('what the goods did, as marketplace-service judges it (#323)', () => {
  const mirrorText = readSource(...RETURNS, 'return-mirror.ts');
  const decide = squash(
    collect(parseSource(mirrorText), ts.isFunctionDeclaration)
      .find((node) => node.name?.text === 'decideMirror')
      ?.getText(),
  );
  const viewsText = readSource(
    'services',
    'inventory-service',
    'src',
    'return-shipment',
    'views.ts',
  );

  it('has the statuses the portal labels, physical ones included, in order', () => {
    expect(literalsOf(topLevelConst(machine, 'RETURN_STATUSES').getText())).toEqual([
      ...RETURN_STATUSES,
    ]);
    expect(literalsOf(topLevelConst(machine, 'PHYSICAL_RETURN_STATUSES').getText())).toEqual([
      ...PHYSICAL_RETURN_STATUSES,
    ]);
  });

  it('counts every request but a refused or withdrawn one as holding its units', () => {
    expect(squash(topLevelConst(machine, 'RETURN_STATUSES_HOLDING_UNITS').getText())).toBe(
      "RETURN_STATUSES.filter((status)=>status!=='REJECTED'&&status!=='CANCELLED',)",
    );
    expect(serviceText).toContain(
      'returnRequest: { status: { in: [...RETURN_STATUSES_HOLDING_UNITS] } }',
    );
  });

  it('moves a request only for a shipment of its supplier, buyer and order, once authorized, and only the one already on it', () => {
    expect(decide).toContain(
      'request.supplierOrganizationId!==envelope.tenantId||request.organizationId!==payload.buyerOrganizationId||request.orderId!==payload.orderId',
    );
    expect(decide).toContain("request.status!=='AUTHORIZED'&&!PHYSICAL.includes(request.status)");
    expect(decide).toContain(
      'request.returnShipmentId!==null&&request.returnShipmentId!==payload.returnShipmentId',
    );
    // The envelope's tenant is the payload's organization: the warehouse owner.
    expect(squash(mirrorText)).toContain('envelope.tenantId!==payload.organizationId');
  });

  it('checks lines as the portal does: of the request, its product, at most authorized; exact unless partial dispatch is allowed', () => {
    const lines = squash(
      collect(parseSource(mirrorText), ts.isFunctionDeclaration)
        .find((node) => node.name?.text === 'assertLinesOfRequest')
        ?.getText(),
    );
    expect(lines).toContain('if(!own||own.productId!==line.productId)thrownotOfRequest');
    expect(lines).toContain('if(line.expectedQuantity>own.quantity)');
    expect(lines).toContain('!rules.partialDispatchAllowed&&line.expectedQuantity!==own.quantity');
    expect(lines).toContain('if(quantity>requested.get(orderLineId)!.quantity)');
    // The portal cannot know this setting, so it holds a shipment nothing has
    // mirrored to the strict rule; its default is that rule.
    expect(squash(marketplaceEnv)).toContain(
      'MARKETPLACE_RETURN_PARTIAL_DISPATCH_ALLOWED:booleanEnv(false)',
    );
    expect(squash(marketplaceEnv)).toContain(
      'MARKETPLACE_RETURN_MIRROR_CONSUMER_ENABLED:booleanEnv(false)',
    );
  });

  it('shows on the request the shipment and the steps it mirrored', () => {
    const view = readSource(...RETURNS, 'views.ts');
    for (const field of [
      'returnShipmentId',
      'inTransitAt',
      'receivedAt',
      'inspectedAt',
      'resolvedAt',
    ]) {
      expect([field, view.includes(`${field}:`)]).toEqual([field, true]);
    }
  });

  it('lists a shipment with the facts the portal checks it by', () => {
    for (const field of [
      'organizationId: row.organizationId',
      'buyerOrganizationId: row.buyerOrganizationId',
      'returnRequestId: row.returnRequestId',
      'orderId: row.orderId',
      'expectedQuantity: line.expectedQuantity',
      'receivedQuantity: line.receivedQuantity',
    ]) {
      expect([field, viewsText.includes(field)]).toEqual([field, true]);
    }
  });
});
