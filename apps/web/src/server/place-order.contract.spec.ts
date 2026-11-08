/**
 * @jest-environment node
 */
import ts from 'typescript';

import {
  PLACE_ORDER_FIELD_MAPPING,
  canPlaceOrder,
  parsePlaceOrderForm,
  placeOrderFormValues,
  placeOrderRequest,
} from './place-order';
import {
  OFFER_CHANGED_MESSAGE,
  PLACE_ORDER_FIELDS,
  PLACE_ORDER_LIMITS,
} from '@/lib/place-order-fields';
import {
  collect,
  decoratorOf,
  parseSource,
  readSource,
  rolesOf,
  schemaProperties,
  squash,
  topLevelConst,
} from '@/test/service-source';

/**
 * What placing an order depends on, pinned to marketplace-service's source —
 * the technique of `asset-commands.contract.spec.ts`: A-02 forbids importing
 * `services/*\/src`, so the portal keeps copies and this test fails the moment
 * a copy and its original disagree. The reader refuses anything it cannot read
 * literally rather than skipping it.
 */

const SERVICE = ['services', 'marketplace-service', 'src', 'order'] as const;
const controller = parseSource(readSource(...SERVICE, 'order.controller.ts'));
const dto = parseSource(readSource(...SERVICE, 'dto.ts'));
const pricing = readSource(...SERVICE, 'pricing.ts');
const orderService = readSource(...SERVICE, 'order.service.ts');
const orderDto = readSource(...SERVICE, 'dto.ts');

describe('the endpoint', () => {
  it('is POST /v1/orders, version 1, and requires an Idempotency-Key', () => {
    const classDecorator = collect(controller, ts.isClassDeclaration)
      .flatMap((node) => ts.getDecorators(node) ?? [])
      .map((decorator) => decorator.expression)
      .filter(ts.isCallExpression)
      .find((call) => call.expression.getText() === 'Controller');
    expect(squash(classDecorator?.arguments[0]?.getText())).toBe("{path:'orders',version:'1'}");

    expect(decoratorOf(controller, 'place', 'Post')?.arguments).toHaveLength(0);
    // The service reads the header and refuses its absence.
    const place = collect(controller, ts.isMethodDeclaration).find(
      (node) => node.name.getText() === 'place',
    );
    expect(place?.getText()).toContain('requireIdempotencyKey(idempotencyKey)');
  });

  it('admits exactly the roles the portal offers the form to', () => {
    const roles = rolesOf(controller, 'place');
    expect([...roles].sort()).toEqual(
      ['ORGANIZATION_ADMIN', 'PROCUREMENT_USER', 'SYSTEM_ADMIN', 'UNION_ADMIN'].sort(),
    );
    for (const role of roles) expect(canPlaceOrder([role])).toBe(true);
    for (const role of ['SUPPLIER', 'FLEET_MANAGER', 'OPERATOR', 'DRIVER', 'AUDITOR']) {
      expect(roles).not.toContain(role);
      expect(canPlaceOrder([role])).toBe(false);
    }
  });
});

describe('the body', () => {
  const schema = squash(topLevelConst(dto, 'createOrderSchema').getText()) ?? '';

  it('is strict, and has no price — a body with one is refused, not ignored', () => {
    expect(schema).toContain('.strict()');
    expect([...schemaProperties(dto, 'createOrderSchema').keys()].sort()).toEqual([
      'lines',
      'note',
    ]);
    expect(schema).not.toMatch(/price|amount|total|currency/i);
  });

  it('takes lines of exactly an offerId, the offerVersion read, and a quantity', () => {
    expect(schema).toContain('offerId:z.string().trim().min(1).max(64)');
    // Required (D-156): no `.optional()`, no `.default(` — the portal must always send it.
    expect(schema).toContain('offerVersion:z.number().int().min(1).max(2_147_483_647),');
    expect(schema).toContain('quantity:z.number().int().positive()');
  });

  it('caps the quantity where the portal does', () => {
    expect(PLACE_ORDER_LIMITS.quantity.max).toBe(1_000_000);
    expect(schema).toContain('.max(1_000_000)');
  });

  it('is what the portal sends: lines only — the note the schema accepts is not persisted, so not sent', () => {
    // The stamp is the form's, not the body's: the version comes out of it.
    expect([...PLACE_ORDER_FIELDS].sort()).toEqual(['offerId', 'offerStamp', 'quantity']);
    const parsed = parsePlaceOrderForm(
      placeOrderFormValues(
        (() => {
          const data = new FormData();
          data.set('offerId', 'OFR_1');
          data.set('quantity', '2');
          data.set('note', 'x'); // a posted note is ignored, not forwarded
          return data;
        })(),
      ),
    );
    if (!parsed.ok) throw new Error('expected a parsed form');
    const request = placeOrderRequest(parsed.line, 2);
    expect(Object.keys(request).sort()).toEqual(['lines']);
    expect(Object.keys(request.lines[0]!).sort()).toEqual(['offerId', 'offerVersion', 'quantity']);
  });
});

describe('the sentences the portal translates', () => {
  it('are the ones the service really throws', () => {
    const translated = Object.keys(PLACE_ORDER_FIELD_MAPPING.messages ?? {}).filter(
      (sentence) => sentence !== 'Missing Idempotency-Key',
    );
    expect(translated.length).toBeGreaterThan(0);
    for (const sentence of translated) {
      expect([sentence, (pricing + orderService + orderDto).includes(`'${sentence}'`)]).toEqual([
        sentence,
        true,
      ]);
    }
  });

  it('leave the two with live numbers to the code fallback — their text carries an offer id', () => {
    expect(pricing).toContain(
      '`Offer ${offer.id} has a minimum quantity of ${offer.minimumQuantity}`',
    );
    expect(pricing).toContain('`Offer ${offer.id} has ${offer.availableQuantity} available`');
    expect(PLACE_ORDER_FIELD_MAPPING.byCode?.BUSINESS_RULE_VIOLATION).toEqual(expect.any(String));
  });

  it('say "the offer changed" for the closed code a stale version is refused with (D-156)', () => {
    // The code, its path and its status, as pricing.ts throws them.
    expect(pricing).toContain("export const OFFER_VERSION_CHANGED = 'OFFER_VERSION_CHANGED';");
    expect(pricing).toContain('path: `lines[${index}].offerVersion`');
    expect(pricing).toContain('ERROR_CODES.OPTIMISTIC_LOCK_FAILED, OFFER_VERSION_CHANGED_MESSAGE');
    expect(pricing).toContain(
      'if (offer.version !== line.offerVersion) throw offerVersionChanged(index);',
    );
    expect(PLACE_ORDER_FIELD_MAPPING.byDetailCode?.OFFER_VERSION_CHANGED).toBe(
      OFFER_CHANGED_MESSAGE,
    );
    expect(PLACE_ORDER_FIELD_MAPPING.paths['lines[0].offerVersion']).toBe('offerStamp');
    // The version check comes after the visibility 404: a stranger learns nothing from it.
    expect(pricing.indexOf("offer.status !== 'PUBLISHED'")).toBeLessThan(
      pricing.indexOf('offer.version !== line.offerVersion'),
    );
  });

  it('keep every business rule on one code, which is why the fallback is by code', () => {
    const rules = pricing.match(/RastaError\.businessRule\(/g) ?? [];
    expect(rules.length).toBeGreaterThanOrEqual(6);
    // An unpublished offer is `notFound`, not a business rule: a buyer is told
    // it is no longer on offer, never that it exists but is hidden.
    expect(pricing).toContain("offer.status !== 'PUBLISHED'");
    // Without the requested id: it is the client's text (S-09, #259).
    expect(pricing).toContain("RastaError.notFound('Offer');");
  });
});
