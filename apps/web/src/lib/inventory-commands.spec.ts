/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as commands from './inventory-commands';
import {
  AMOUNT_FIELD,
  CONSIGNEE_FIELD,
  DIRECTION_FIELD,
  INVENTORY_COMMANDS,
  INVENTORY_COMMAND_CONSEQUENCES,
  INVENTORY_COMMAND_LABELS,
  INVENTORY_DONE_MESSAGES,
  INVENTORY_FORM_MESSAGES,
  LATITUDE_FIELD,
  LONGITUDE_FIELD,
  NAME_FIELD,
  ORDER_FIELD,
  PRODUCT_FIELD,
  QUANTITY_FIELD,
  SCOPE_COMMANDS,
  SOURCE_FIELD,
  STOCK_ITEM_FIELD,
  hasFields,
  inventoryFormValues,
  legField,
  movementTypeLabel,
  parseInventoryForm,
  shipmentStatusLabel,
  valuesOfBody,
  type InventoryBody,
  type InventoryCommand,
} from './inventory-commands';

/**
 * Reading the inventory forms: every field of every typed command, what it
 * refuses and in which words, that what a retry re-posts (`valuesOfBody`)
 * parses back to the very body that was kept, and that no fixed text of these
 * screens carries a hamza.
 */

const ULID = '01HZZZZZZZZZZZZZZZZZZZZZZZ';
const PRODUCT = `PRD_${ULID}`;
const ITEM = `SKI_${ULID}`;
const CONSIGNEE = `ORG_${ULID}`;

function ok(command: InventoryCommand, values: Record<string, string>): InventoryBody {
  const parsed = parseInventoryForm(command, values);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed));
  return parsed.body;
}

function errors(command: InventoryCommand, values: Record<string, string>) {
  const parsed = parseInventoryForm(command, values);
  if (parsed.ok) throw new Error('expected a refusal');
  return parsed;
}

describe('the vocabulary', () => {
  it('has a label, a consequence and a confirmation for every command, and a slot to live in', () => {
    for (const command of INVENTORY_COMMANDS) {
      expect(INVENTORY_COMMAND_LABELS[command]).toMatch(/\S/);
      expect(INVENTORY_COMMAND_CONSEQUENCES[command]).toMatch(/\S/);
      expect(INVENTORY_DONE_MESSAGES[command]).toMatch(/\S/);
    }
    expect(Object.values(SCOPE_COMMANDS).flat().sort()).toEqual([...INVENTORY_COMMANDS].sort());
  });

  it('says what an adjustment does not have: no reason, no second approval', () => {
    expect(INVENTORY_COMMAND_CONSEQUENCES.ADJUST_STOCK).toContain('دلیل یا تایید دوم نمی‌خواهد');
  });

  it('shows a status or a movement it does not know as it arrived', () => {
    expect(shipmentStatusLabel('CREATED')).not.toBe('CREATED');
    expect(shipmentStatusLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
    expect(movementTypeLabel('ADJUSTMENT')).not.toBe('ADJUSTMENT');
    expect(movementTypeLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });

  it('reads only the known fields of a posted form', () => {
    const form = new FormData();
    form.set(NAME_FIELD, 'x');
    form.set('organizationId', 'ORG-OTHER');
    form.set('csrf', 'token');
    form.set(legField(0, 'carrierName'), 'y');
    form.set('leg.0.surprise', 'z');
    expect(inventoryFormValues(form)).toEqual({ name: 'x', 'leg.0.carrierName': 'y' });
  });
});

describe('a warehouse', () => {
  it('needs a name, bounds it, and takes a location only whole', () => {
    expect(ok('CREATE_WAREHOUSE', { [NAME_FIELD]: '  انبار   مرکزی ' })).toEqual({
      name: 'انبار مرکزی',
      location: null,
    });
    expect(errors('CREATE_WAREHOUSE', {}).fieldErrors[NAME_FIELD]).toBe(
      INVENTORY_FORM_MESSAGES.nameMissing,
    );
    expect(
      errors('CREATE_WAREHOUSE', { [NAME_FIELD]: 'ا'.repeat(201) }).fieldErrors[NAME_FIELD],
    ).toBe(INVENTORY_FORM_MESSAGES.nameLong);
    expect(errors('CREATE_WAREHOUSE', { [NAME_FIELD]: 'a‮b' }).fieldErrors[NAME_FIELD]).toBe(
      INVENTORY_FORM_MESSAGES.characters,
    );
    expect(
      errors('CREATE_WAREHOUSE', { [NAME_FIELD]: 'x', [LATITUDE_FIELD]: '35' }).fieldErrors[
        LONGITUDE_FIELD
      ],
    ).toBe(INVENTORY_FORM_MESSAGES.bothCoordinates);
  });

  it('reads Persian digits and the Persian decimal separator, and bounds both coordinates', () => {
    expect(
      ok('CREATE_WAREHOUSE', {
        [NAME_FIELD]: 'x',
        [LATITUDE_FIELD]: '−۳۵٫۷',
        [LONGITUDE_FIELD]: '۵۱٫۴',
      }),
    ).toEqual({ name: 'x', location: { latitude: -35.7, longitude: 51.4 } });
    const bad = errors('CREATE_WAREHOUSE', {
      [NAME_FIELD]: 'x',
      [LATITUDE_FIELD]: '91',
      [LONGITUDE_FIELD]: '181',
    });
    expect(bad.fieldErrors).toEqual({
      [LATITUDE_FIELD]: INVENTORY_FORM_MESSAGES.latitude,
      [LONGITUDE_FIELD]: INVENTORY_FORM_MESSAGES.longitude,
    });
    expect(
      errors('CREATE_WAREHOUSE', {
        [NAME_FIELD]: 'x',
        [LATITUDE_FIELD]: 'abc',
        [LONGITUDE_FIELD]: '1',
      }).fieldErrors[LATITUDE_FIELD],
    ).toBe(INVENTORY_FORM_MESSAGES.latitude);
  });
});

describe('a receipt', () => {
  const fields = { [PRODUCT_FIELD]: PRODUCT, [QUANTITY_FIELD]: '۱٬۲۰۰'.replace('٬', '') };

  it('takes a product, a whole positive quantity and an optional document reference', () => {
    expect(ok('RECEIVE_STOCK', fields)).toEqual({
      productId: PRODUCT,
      quantity: 1200,
      sourceReference: null,
    });
    expect(ok('RECEIVE_STOCK', { ...fields, [SOURCE_FIELD]: ` adj_${ULID} ` })).toMatchObject({
      sourceReference: `ADJ_${ULID}`,
    });
  });

  it.each([
    ['zero', '0'],
    ['negative', '-5'],
    ['a fraction', '2.5'],
    ['past the largest stored', '2147483648'],
    ['text', 'many'],
    ['nothing', ''],
  ])('refuses a quantity of %s', (_name, quantity) => {
    expect(errors('RECEIVE_STOCK', { ...fields, [QUANTITY_FIELD]: quantity }).fieldErrors).toEqual({
      [QUANTITY_FIELD]: INVENTORY_FORM_MESSAGES.quantity,
    });
  });

  it('accepts the largest quantity stored', () => {
    expect(ok('RECEIVE_STOCK', { ...fields, [QUANTITY_FIELD]: '2147483647' })).toMatchObject({
      quantity: 2147483647,
    });
  });

  it('refuses a product or a reference of another shape', () => {
    expect(errors('RECEIVE_STOCK', { ...fields, [PRODUCT_FIELD]: 'cement' }).fieldErrors).toEqual({
      [PRODUCT_FIELD]: INVENTORY_FORM_MESSAGES.product,
    });
    expect(errors('RECEIVE_STOCK', { ...fields, [SOURCE_FIELD]: 'INV_1' }).fieldErrors).toEqual({
      [SOURCE_FIELD]: INVENTORY_FORM_MESSAGES.source,
    });
  });
});

describe('an adjustment', () => {
  const fields = { [STOCK_ITEM_FIELD]: ITEM, [DIRECTION_FIELD]: 'DECREASE', [AMOUNT_FIELD]: '۵' };

  it('is a signed delta: the direction is chosen, the amount is positive — never zero', () => {
    expect(ok('ADJUST_STOCK', fields)).toEqual({
      stockItemId: ITEM,
      quantityDelta: -5,
      sourceReference: null,
    });
    expect(ok('ADJUST_STOCK', { ...fields, [DIRECTION_FIELD]: 'INCREASE' })).toMatchObject({
      quantityDelta: 5,
    });
    expect(errors('ADJUST_STOCK', { ...fields, [AMOUNT_FIELD]: '0' }).fieldErrors).toEqual({
      [AMOUNT_FIELD]: INVENTORY_FORM_MESSAGES.quantity,
    });
  });

  it('refuses a missing direction or item, and a delta the schema would refuse', () => {
    expect(errors('ADJUST_STOCK', { ...fields, [DIRECTION_FIELD]: '' }).fieldErrors).toEqual({
      [DIRECTION_FIELD]: INVENTORY_FORM_MESSAGES.direction,
    });
    expect(errors('ADJUST_STOCK', { ...fields, [STOCK_ITEM_FIELD]: '' }).fieldErrors).toEqual({
      [STOCK_ITEM_FIELD]: INVENTORY_FORM_MESSAGES.stockItem,
    });
    expect(errors('ADJUST_STOCK', { ...fields, [AMOUNT_FIELD]: '2147483648' }).fieldErrors).toEqual(
      {
        [AMOUNT_FIELD]: INVENTORY_FORM_MESSAGES.quantity,
      },
    );
  });

  it('has no reason or approval field to read', () => {
    const body = ok('ADJUST_STOCK', { ...fields, reason: 'count', approvedBy: 'someone' });
    expect(Object.keys(body).sort()).toEqual(['quantityDelta', 'sourceReference', 'stockItemId']);
  });
});

describe('a shipment', () => {
  const fields = {
    [CONSIGNEE_FIELD]: CONSIGNEE,
    [legField(0, 'carrierName')]: 'باربری یک',
  };

  it('takes a consignee and one to ten legs in order; a blank leg between others is dropped', () => {
    expect(ok('CREATE_SHIPMENT', fields)).toEqual({
      consigneeOrganizationId: CONSIGNEE,
      orderReference: null,
      legs: [{ carrierName: 'باربری یک', carrierReference: null }],
    });
    expect(
      ok('CREATE_SHIPMENT', {
        ...fields,
        [ORDER_FIELD]: `po_${ULID}`,
        [legField(0, 'carrierReference')]: 'WB 12',
        [legField(1, 'carrierName')]: '  ',
        [legField(2, 'carrierName')]: 'دو',
      }),
    ).toEqual({
      consigneeOrganizationId: CONSIGNEE,
      orderReference: `PO_${ULID}`,
      legs: [
        { carrierName: 'باربری یک', carrierReference: 'WB 12' },
        { carrierName: 'دو', carrierReference: null },
      ],
    });
  });

  it('accepts the readable consignee id of the seeds', () => {
    expect(ok('CREATE_SHIPMENT', { ...fields, [CONSIGNEE_FIELD]: 'ORG-DEH-0002' })).toMatchObject({
      consigneeOrganizationId: 'ORG-DEH-0002',
    });
  });

  it('refuses a consignee, an order reference, a carrier or a reference of another shape', () => {
    expect(errors('CREATE_SHIPMENT', { ...fields, [CONSIGNEE_FIELD]: 'x' }).fieldErrors).toEqual({
      [CONSIGNEE_FIELD]: INVENTORY_FORM_MESSAGES.consignee,
    });
    expect(errors('CREATE_SHIPMENT', { ...fields, [ORDER_FIELD]: 'ORD_1' }).fieldErrors).toEqual({
      [ORDER_FIELD]: INVENTORY_FORM_MESSAGES.orderReference,
    });
    expect(
      errors('CREATE_SHIPMENT', { ...fields, [legField(0, 'carrierName')]: '' }).fieldErrors,
    ).toEqual({ [legField(0, 'carrierName')]: INVENTORY_FORM_MESSAGES.carrierName });
    expect(
      errors('CREATE_SHIPMENT', {
        ...fields,
        [legField(0, 'carrierReference')]: 'a\u0000b',
      }).fieldErrors,
    ).toEqual({ [legField(0, 'carrierReference')]: INVENTORY_FORM_MESSAGES.carrierReference });
  });

  it('refuses no legs at all and more than ten', () => {
    expect(errors('CREATE_SHIPMENT', { [CONSIGNEE_FIELD]: CONSIGNEE }).message).toBe(
      INVENTORY_FORM_MESSAGES.legs,
    );
    const eleven: Record<string, string> = { [CONSIGNEE_FIELD]: CONSIGNEE };
    for (let index = 0; index < 11; index += 1)
      eleven[legField(index, 'carrierName')] = `c${index}`;
    expect(errors('CREATE_SHIPMENT', eleven).message).toBe(INVENTORY_FORM_MESSAGES.legs);
  });
});

describe('a move has no fields', () => {
  it('the dispatch and the delivery read nothing: their whole body is the stamped version', () => {
    expect(hasFields('DISPATCH_SHIPMENT')).toBe(false);
    expect(hasFields('DELIVER_SHIPMENT')).toBe(false);
    for (const command of ['DISPATCH_SHIPMENT', 'DELIVER_SHIPMENT'] as const) {
      expect(parseInventoryForm(command, { expectedVersion: '9' })).toMatchObject({ ok: false });
      expect(valuesOfBody(command, {} as InventoryBody)).toEqual({});
    }
  });
});

describe('what a retry re-posts parses back to the body that was kept', () => {
  const cases: readonly [InventoryCommand, Record<string, string>][] = [
    [
      'CREATE_WAREHOUSE',
      { [NAME_FIELD]: 'انبار', [LATITUDE_FIELD]: '-35.7', [LONGITUDE_FIELD]: '51.4' },
    ],
    ['CREATE_WAREHOUSE', { [NAME_FIELD]: 'انبار' }],
    [
      'RECEIVE_STOCK',
      { [PRODUCT_FIELD]: PRODUCT, [QUANTITY_FIELD]: '7', [SOURCE_FIELD]: `ORD_${ULID}` },
    ],
    [
      'ADJUST_STOCK',
      { [STOCK_ITEM_FIELD]: ITEM, [DIRECTION_FIELD]: 'DECREASE', [AMOUNT_FIELD]: '3' },
    ],
    [
      'ADJUST_STOCK',
      {
        [STOCK_ITEM_FIELD]: ITEM,
        [DIRECTION_FIELD]: 'INCREASE',
        [AMOUNT_FIELD]: '3',
        [SOURCE_FIELD]: `ADJ_${ULID}`,
      },
    ],
    [
      'CREATE_SHIPMENT',
      {
        [CONSIGNEE_FIELD]: CONSIGNEE,
        [ORDER_FIELD]: `ORD_${ULID}`,
        [legField(0, 'carrierName')]: 'یک',
        [legField(3, 'carrierName')]: 'دو',
        [legField(3, 'carrierReference')]: 'R',
      },
    ],
  ];

  it.each(cases)('%s', (command, values) => {
    const body = ok(command, values);
    expect(ok(command, valuesOfBody(command, body))).toEqual(body);
  });
});

describe('every body the parser accepts survives a retry losslessly', () => {
  // A small deterministic generator: the same cases on every run.
  let seed = 0x2f6e2b1;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const digits = (count: number) =>
    Array.from({ length: count }, () => Math.floor(random() * 10)).join('');

  const COORDINATES = [
    '0',
    '-0',
    '0.0000001',
    '-0.0000001',
    '0.000000000001',
    '-0.000000000001',
    '90',
    '-90',
    '180',
    '-180',
    '179.999999999999',
    '-179.999999999999',
    '35.7',
    '51.4',
    '0.1',
    '0.30000000000004',
    '100',
    '٣٥٫٧۰۰۰۰۰۱',
    '−12.5',
    '007.5',
  ];
  const randomCoordinate = (limit: number) => {
    const places = Math.floor(random() * 13);
    const whole = Math.floor(random() * (limit + 1));
    const fraction = places === 0 ? '' : `.${digits(places)}`;
    const typed = `${random() < 0.5 ? '-' : ''}${whole}${fraction}`;
    return typed;
  };
  const NAMES = [
    'انبار مرکزی',
    '  انبار   با   فاصله  ',
    'كتاب ي ك ە',
    'نیم‌فاصله‌ دار',
    'Warehouse 12',
    'ـــ کشیده',
    'á combining',
    '😀 انبار',
    'x'.repeat(200),
    'O\'Brien & <b>tags</b> "quotes" \\ backslash',
    '٠١٢٣٤٥٦٧٨٩ ۰۱۲۳۴۵۶۷۸۹',
    '‌‌صفر',
    'ﻻ ﷲ ﬁ',
    ' nbsp ',
  ];
  const quantities = [1, 2, 9, 10, 99, 120, 1_000_000, 2_147_483_647, 9_999_999_999];
  const sources = [null, `ORD_${ULID}`, `PO_${ULID}`, `ADJ_${ULID}`];
  const REFERENCES = [
    '',
    'AB-123',
    'ref with spaces',
    '1e-7',
    '۰۱۲',
    'x'.repeat(100),
    'ref"quote',
    '٣٥٫٧',
  ];

  /** The body through the whole retry path: spelled as hidden fields, read again, and stored as JSON. */
  function survives(command: InventoryCommand, body: InventoryBody) {
    const stored = JSON.parse(JSON.stringify(body)) as InventoryBody;
    expect(stored).toEqual(body);
    const again = parseInventoryForm(command, valuesOfBody(command, stored));
    if (!again.ok) throw new Error(`${command} ${JSON.stringify(body)} → ${JSON.stringify(again)}`);
    expect(again.body).toEqual(body);
    // Reading the retry's own spelling once more changes nothing either.
    const third = parseInventoryForm(command, valuesOfBody(command, again.body));
    expect(third).toEqual(again);
  }

  function accepted(
    command: InventoryCommand,
    values: Record<string, string>,
  ): InventoryBody | null {
    const parsed = parseInventoryForm(command, values);
    return parsed.ok ? parsed.body : null;
  }

  it('spells a coordinate as a plain decimal, never in exponent notation', () => {
    for (const value of [1e-7, -1e-7, 1e-12, 123.456, 0, 90, -180, 0.1 + 0.2, 1e-10]) {
      const text = commands.coordinateText(value);
      expect(text).toMatch(/^-?[0-9]{1,3}(\.[0-9]{1,12})?$/);
    }
    expect(commands.coordinateText(1e-7)).toBe('0.0000001');
    expect(commands.coordinateText(-35.7)).toBe('-35.7');
    expect(commands.coordinateText(90)).toBe('90');
  });

  it('a warehouse: the tiny, the large, the negative and the odd name', () => {
    let count = 0;
    const cases: [string, string, string][] = [];
    for (const name of NAMES) {
      cases.push([name, '', '']);
      for (const latitude of COORDINATES) {
        for (const longitude of [pick(COORDINATES), '0.0000001', '-179.999999999999']) {
          cases.push([name, latitude, longitude]);
        }
      }
    }
    for (let index = 0; index < 3000; index += 1) {
      cases.push([pick(NAMES), randomCoordinate(90), randomCoordinate(180)]);
    }
    for (const [name, latitude, longitude] of cases) {
      const body = accepted('CREATE_WAREHOUSE', {
        [NAME_FIELD]: name,
        [LATITUDE_FIELD]: latitude,
        [LONGITUDE_FIELD]: longitude,
      });
      if (body === null) continue;
      count += 1;
      survives('CREATE_WAREHOUSE', body);
    }
    expect(count).toBeGreaterThan(1000);
    // The case the review found: it is accepted, and it must come back.
    const tiny = ok('CREATE_WAREHOUSE', {
      [NAME_FIELD]: 'x',
      [LATITUDE_FIELD]: '0.0000001',
      [LONGITUDE_FIELD]: '51.4',
    });
    expect(tiny).toEqual({ name: 'x', location: { latitude: 1e-7, longitude: 51.4 } });
    expect(valuesOfBody('CREATE_WAREHOUSE', tiny)[LATITUDE_FIELD]).toBe('0.0000001');
    survives('CREATE_WAREHOUSE', tiny);
  });

  it('a receipt: every quantity, every source', () => {
    let count = 0;
    const typedQuantities = [
      ...quantities.map(String),
      ...Array.from({ length: 300 }, () => digits(1 + Math.floor(random() * 10))),
    ];
    for (const quantity of typedQuantities) {
      for (const sourceReference of sources) {
        const body = accepted('RECEIVE_STOCK', {
          [PRODUCT_FIELD]: PRODUCT,
          [QUANTITY_FIELD]: quantity,
          [SOURCE_FIELD]: sourceReference ?? '',
        });
        if (body === null) continue;
        count += 1;
        survives('RECEIVE_STOCK', body);
      }
    }
    expect(count).toBeGreaterThan(100);
    survives(
      'RECEIVE_STOCK',
      ok('RECEIVE_STOCK', {
        [PRODUCT_FIELD]: ` ${PRODUCT.toLowerCase()} `,
        [QUANTITY_FIELD]: '۱۲۰',
        [SOURCE_FIELD]: ` ord_${ULID.toLowerCase()}`,
      }),
    );
  });

  it('an adjustment: both directions, the smallest and the largest amounts', () => {
    let count = 0;
    const typedAmounts = [
      ...quantities.map(String),
      ...Array.from({ length: 300 }, () => digits(1 + Math.floor(random() * 10))),
    ];
    for (const amount of typedAmounts) {
      for (const direction of ['INCREASE', 'DECREASE']) {
        for (const sourceReference of sources) {
          const body = accepted('ADJUST_STOCK', {
            [STOCK_ITEM_FIELD]: ITEM,
            [DIRECTION_FIELD]: direction,
            [AMOUNT_FIELD]: amount,
            [SOURCE_FIELD]: sourceReference ?? '',
          });
          if (body === null) continue;
          count += 1;
          survives('ADJUST_STOCK', body);
        }
      }
    }
    expect(count).toBeGreaterThan(200);
  });

  it('a shipment: one to ten legs, odd carrier names and references', () => {
    let count = 0;
    for (let index = 0; index < 1500; index += 1) {
      const values: Record<string, string> = {
        [CONSIGNEE_FIELD]: pick([CONSIGNEE, 'ORG-DEH-0002', ` org-deh-0002 `]),
        [ORDER_FIELD]: pick(['', `ORD_${ULID}`, `PO_${ULID}`]),
      };
      const legs = 1 + Math.floor(random() * 10);
      for (let leg = 0; leg < legs; leg += 1) {
        values[legField(leg, 'carrierName')] = pick(NAMES);
        values[legField(leg, 'carrierReference')] = pick(REFERENCES);
      }
      const body = accepted('CREATE_SHIPMENT', values);
      if (body === null) continue;
      count += 1;
      survives('CREATE_SHIPMENT', body);
    }
    expect(count).toBeGreaterThan(300);
  });
});

describe('fixed words', () => {
  /** A hamza on a word (أ إ ؤ ئ ء ۀ) and the combining hamza above (U+0654) are not written here. */
  const HAMZA = new RegExp('\\u0621|\\u0623|\\u0624|\\u0625|\\u0626|\\u06C0|\\u0654');

  function strings(value: unknown, into: string[] = []): string[] {
    if (typeof value === 'string') into.push(value);
    else if (Array.isArray(value)) for (const item of value) strings(item, into);
    else if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value)) strings(item, into);
    }
    return into;
  }

  it('none of the exported texts carries one', () => {
    const texts = strings(Object.values(commands));
    expect(texts.length).toBeGreaterThan(40);
    for (const text of texts) expect([text, HAMZA.test(text)]).toEqual([text, false]);
  });

  it('nor does the source of any screen file written for these commands', () => {
    const root = join(__dirname, '..');
    const files = [
      'app/inventory/InventoryCommandForm.tsx',
      'app/inventory/InventoryCommands.tsx',
      'app/inventory/InventoryScreen.tsx',
      'app/inventory/page.tsx',
      'app/inventory/shipments/[id]/ShipmentScreen.tsx',
      'app/inventory/shipments/[id]/page.tsx',
      'lib/inventory-commands.ts',
    ];
    for (const file of files) {
      // «صفحهٔ بعد» is the read-only screen's own link, older than these commands.
      const text = readFileSync(join(root, file), 'utf8').replace('صفحهٔ بعد', '');
      expect([file, HAMZA.test(text)]).toEqual([file, false]);
    }
  });
});
