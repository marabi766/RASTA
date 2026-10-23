import { normalizePersianText, toLatinDigits, toPersianDigits } from './format';
import { MAX_STOCK_QUANTITY } from './inventory-fields';

/**
 * The operator commands of `/inventory` (EXP-004 criterion 1 and 2;
 * inventory-service `warehouse`, `stock` and `shipment` controllers, ADR-056):
 * the closed vocabulary, the form fields, how a form is read, and the fixed
 * Persian sentences every refusal is said in. Client-safe: the forms read this
 * to remember what they send, and the server actions read it again, so the
 * remembered request and the sent request cannot differ.
 *
 * What the API does **not** have, and so this portal does not draw: no command
 * edits or retires a warehouse (Q-108: it is `ACTIVE` and nothing else), an
 * adjustment takes no reason code and no second approval (Q-109), and
 * reservations and return shipments are driven by the marketplace flows, so
 * they are never commanded from here.
 */

export const INVENTORY_COMMANDS = [
  'CREATE_WAREHOUSE',
  'RECEIVE_STOCK',
  'ADJUST_STOCK',
  'CREATE_SHIPMENT',
  'DISPATCH_SHIPMENT',
  'DELIVER_SHIPMENT',
] as const;
export type InventoryCommand = (typeof INVENTORY_COMMANDS)[number];

export function isInventoryCommand(value: unknown): value is InventoryCommand {
  return typeof value === 'string' && (INVENTORY_COMMANDS as readonly string[]).includes(value);
}

/**
 * Where an unresolved command is kept (`lib/unresolved-inventory.ts`): the
 * warehouse list (a new warehouse), one warehouse (a receipt, an adjustment, a
 * new shipment out of it) or one shipment (its dispatch and its delivery).
 */
export type InventoryScope =
  | { readonly kind: 'WAREHOUSES' }
  | { readonly kind: 'WAREHOUSE'; readonly warehouseId: string }
  | { readonly kind: 'SHIPMENT'; readonly shipmentId: string };

/** The commands a slot holds. */
export const SCOPE_COMMANDS: Readonly<Record<InventoryScope['kind'], readonly InventoryCommand[]>> =
  {
    WAREHOUSES: ['CREATE_WAREHOUSE'],
    WAREHOUSE: ['RECEIVE_STOCK', 'ADJUST_STOCK', 'CREATE_SHIPMENT'],
    SHIPMENT: ['DISPATCH_SHIPMENT', 'DELIVER_SHIPMENT'],
  };

export const INVENTORY_COMMAND_LABELS: Readonly<Record<InventoryCommand, string>> = {
  CREATE_WAREHOUSE: 'ایجاد انبار',
  RECEIVE_STOCK: 'ثبت رسید کالا',
  ADJUST_STOCK: 'اصلاح یا خروج مستقیم موجودی',
  CREATE_SHIPMENT: 'ایجاد محموله',
  DISPATCH_SHIPMENT: 'ثبت ارسال محموله',
  DELIVER_SHIPMENT: 'ثبت تحویل محموله',
};

/** What each command does, and as truthfully what it does not. */
export const INVENTORY_COMMAND_CONSEQUENCES: Readonly<Record<InventoryCommand, string>> = {
  CREATE_WAREHOUSE:
    'انبار برای همین سازمان ساخته می‌شود. ویرایش یا بستن انبار هنوز در سامانه نیست، پس نام و محل را درست بنویسید.',
  RECEIVE_STOCK:
    'مقدار واردشده به موجودی این کالا در همین انبار افزوده می‌شود و یک حرکت «رسید» در دفتر موجودی ثبت می‌شود. برگشت‌پذیر نیست؛ اشتباه را فقط با یک اصلاح موجودی می‌توان جبران کرد.',
  ADJUST_STOCK:
    'موجودی فیزیکی کالا به اندازه مقدار واردشده زیاد یا کم می‌شود و یک حرکت «اصلاح» با نام شما در دفتر موجودی ثبت می‌شود؛ خروج مستقیم کالا بدون رزرو هم از همین‌جا ثبت می‌شود. موجودی نمی‌تواند از مقدار رزروشده کمتر شود. سامانه برای اصلاح موجودی دلیل یا تایید دوم نمی‌خواهد و چنین فیلدی ندارد؛ فقط مرجع اختیاری سند و خود حرکت ثبت می‌ماند.',
  CREATE_SHIPMENT:
    'محموله از همین انبار ساخته می‌شود و در وضعیت «ایجادشده» می‌ماند. ایجاد محموله موجودی را کم نمی‌کند، و مرحله‌های حمل پس از ایجاد تغییر نمی‌کنند.',
  DISPATCH_SHIPMENT:
    'ثبت می‌شود که محموله از انبار مبدا خارج شد. فقط اپراتور سازمان صاحب انبار مبدا این را ثبت می‌کند و برگشت‌پذیر نیست.',
  DELIVER_SHIPMENT:
    'ثبت می‌شود که محموله تحویل شد. فقط اپراتور سازمان صاحب انبار مبدا این را ثبت می‌کند، گیرنده نمی‌تواند، و برگشت‌پذیر نیست.',
};

/** What the page says once a command is confirmed (the signed flash, `server/flash.ts`). */
export const INVENTORY_DONE_MESSAGES: Readonly<Record<InventoryCommand, string>> = {
  CREATE_WAREHOUSE: 'انبار ایجاد شد.',
  RECEIVE_STOCK: 'رسید کالا ثبت شد و موجودی افزایش یافت.',
  ADJUST_STOCK: 'اصلاح موجودی ثبت شد.',
  CREATE_SHIPMENT: 'محموله ایجاد شد.',
  DISPATCH_SHIPMENT: 'ارسال محموله ثبت شد.',
  DELIVER_SHIPMENT: 'تحویل محموله ثبت شد.',
};

// ---------------------------------------------------------------------------
// Limits (inventory-service `dto.ts`, pinned by `inventory-commands.contract.spec.ts`)
// ---------------------------------------------------------------------------

export const MAX_WAREHOUSE_NAME_LENGTH = 200;
export const MAX_CARRIER_NAME_LENGTH = 200;
export const MAX_CARRIER_REFERENCE_LENGTH = 100;
export const MAX_SHIPMENT_LEGS = 10;

const ULID = '[0-9A-HJKMNP-TV-Z]{26}';
export const PRODUCT_ID_PATTERN = new RegExp(`^PRD_${ULID}$`);
export const STOCK_ITEM_ID_PATTERN = new RegExp(`^SKI_${ULID}$`);
export const SOURCE_REFERENCE_PATTERN = new RegExp(`^(ORD|PO|ADJ)_${ULID}$`);
export const ORDER_REFERENCE_PATTERN = new RegExp(`^(ORD|PO)_${ULID}$`);
export const CONSIGNEE_PATTERN = new RegExp(`^ORG(_${ULID}|-[A-Z0-9-]{1,48})$`);

/** `plainText()` refuses bidirectional controls; `referenceId()` refuses every control and format character. */
const BIDI_CONTROL = /\p{Bidi_Control}/u;
const CONTROL_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Bidi_Control}]/u;

// ---------------------------------------------------------------------------
// The forms
// ---------------------------------------------------------------------------

export const NAME_FIELD = 'name';
export const LATITUDE_FIELD = 'latitude';
export const LONGITUDE_FIELD = 'longitude';
export const PRODUCT_FIELD = 'productId';
export const QUANTITY_FIELD = 'quantity';
export const STOCK_ITEM_FIELD = 'stockItemId';
export const DIRECTION_FIELD = 'direction';
export const AMOUNT_FIELD = 'amount';
export const SOURCE_FIELD = 'sourceReference';
export const CONSIGNEE_FIELD = 'consigneeOrganizationId';
export const ORDER_FIELD = 'orderReference';
export const LEG_PREFIX = 'leg.';

export const DIRECTIONS = ['INCREASE', 'DECREASE'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const DIRECTION_LABELS: Readonly<Record<Direction, string>> = {
  INCREASE: 'افزایش موجودی',
  DECREASE: 'کاهش یا خروج از موجودی',
};

export function legField(index: number, part: 'carrierName' | 'carrierReference'): string {
  return `${LEG_PREFIX}${index}.${part}`;
}

const SCALAR_FIELDS: readonly string[] = [
  NAME_FIELD,
  LATITUDE_FIELD,
  LONGITUDE_FIELD,
  PRODUCT_FIELD,
  QUANTITY_FIELD,
  STOCK_ITEM_FIELD,
  DIRECTION_FIELD,
  AMOUNT_FIELD,
  SOURCE_FIELD,
  CONSIGNEE_FIELD,
  ORDER_FIELD,
];

const LEG_FIELD = /^leg\.(\d{1,2})\.(carrierName|carrierReference)$/;

/** The form as typed: field name to text. Only the fields of {@link INVENTORY_COMMANDS}. */
export type InventoryFormValues = Readonly<Record<string, string>>;

export type InventoryErrors = Partial<Record<string, string>>;

/** The form's values — the known fields only, so a posted extra is never read. */
export function inventoryFormValues(form: FormData): InventoryFormValues {
  const values: Record<string, string> = {};
  for (const [name, value] of form.entries()) {
    if (typeof value !== 'string') continue;
    if (SCALAR_FIELDS.includes(name) || LEG_FIELD.test(name)) values[name] = value;
  }
  return values;
}

export interface WarehouseBody {
  readonly name: string;
  readonly location: { readonly latitude: number; readonly longitude: number } | null;
}

export interface ReceiptBody {
  readonly productId: string;
  readonly quantity: number;
  readonly sourceReference: string | null;
}

export interface AdjustmentBody {
  readonly stockItemId: string;
  readonly quantityDelta: number;
  readonly sourceReference: string | null;
}

export interface ShipmentLegBody {
  readonly carrierName: string;
  readonly carrierReference: string | null;
}

export interface ShipmentBody {
  readonly consigneeOrganizationId: string;
  readonly orderReference: string | null;
  readonly legs: readonly ShipmentLegBody[];
}

/** What a typed command keeps for its retry; the shipment moves are bodiless (the stamp binds their version). */
export type InventoryBody = WarehouseBody | ReceiptBody | AdjustmentBody | ShipmentBody;

export type ParsedInventoryForm =
  | { readonly ok: true; readonly body: InventoryBody }
  | { readonly ok: false; readonly fieldErrors: InventoryErrors; readonly message: string | null };

export const INVENTORY_FORM_MESSAGES = {
  nameMissing: 'نام انبار را بنویسید.',
  nameLong: `نام انبار نباید بیش از ${toPersianDigits(String(MAX_WAREHOUSE_NAME_LENGTH))} نویسه باشد.`,
  characters: 'این فیلد نویسه‌های کنترلی نمی‌پذیرد.',
  latitude: 'عرض جغرافیایی را عددی بین ۹۰- و ۹۰ بنویسید.',
  longitude: 'طول جغرافیایی را عددی بین ۱۸۰- و ۱۸۰ بنویسید.',
  bothCoordinates: 'عرض و طول جغرافیایی را با هم بنویسید، یا هر دو را خالی بگذارید.',
  product: 'شناسه کالا را به شکل PRD_ و ۲۶ نویسه بنویسید.',
  quantity: `تعداد را عدد صحیح مثبت، تا ${toPersianDigits(String(MAX_STOCK_QUANTITY))}، بنویسید.`,
  stockItem: 'یکی از کالاهای انبار را برگزینید.',
  direction: 'افزایش یا کاهش را برگزینید.',
  source: 'مرجع را به شکل ORD_ یا PO_ یا ADJ_ و ۲۶ نویسه بنویسید، یا خالی بگذارید.',
  consignee: 'شناسه سازمان گیرنده را به شکل ORG_ و ۲۶ نویسه (یا ORG- و شناسه خوانا) بنویسید.',
  orderReference: 'مرجع سفارش را به شکل ORD_ یا PO_ و ۲۶ نویسه بنویسید، یا خالی بگذارید.',
  carrierName: `نام حمل‌کننده را بنویسید (تا ${toPersianDigits(String(MAX_CARRIER_NAME_LENGTH))} نویسه).`,
  carrierReference: `شماره پیگیری حمل‌کننده نویسه کنترلی ندارد و حداکثر ${toPersianDigits(String(MAX_CARRIER_REFERENCE_LENGTH))} نویسه است.`,
  legs: `یک محموله یک تا ${toPersianDigits(String(MAX_SHIPMENT_LEGS))} مرحله حمل دارد.`,
} as const;

function text(values: InventoryFormValues, name: string): string {
  return normalizePersianText(values[name] ?? '');
}

/** Latin, trimmed, no inner space: how an id is typed and compared. */
function identifier(values: InventoryFormValues, name: string): string {
  return toLatinDigits(values[name] ?? '')
    .replace(/\s+/g, '')
    .toUpperCase();
}

function wholeNumber(value: string, max: number): number | null {
  const typed = toLatinDigits(value).trim();
  if (!/^[0-9]{1,10}$/.test(typed)) return null;
  const count = Number(typed);
  return count >= 1 && count <= max ? count : null;
}

function coordinate(value: string, limit: number): number | null | 'EMPTY' {
  const typed = toLatinDigits(value)
    .trim()
    .replace(/[٫]/g, '.')
    .replace(/^[−–-]/, '-');
  if (typed === '') return 'EMPTY';
  if (!/^-?[0-9]{1,3}(\.[0-9]{1,12})?$/.test(typed)) return null;
  const number = Number(typed);
  // "-0" is the zero it spells: one value, one spelling, one JSON body.
  return Math.abs(number) <= limit ? (number === 0 ? 0 : number) : null;
}

/**
 * A coordinate as {@link coordinate} reads it back: plain decimal, never
 * exponent notation (`String(1e-7)` is "1e-7", which no form accepts). Twelve
 * places are the most the parser takes, and a double within 1e-14 of a
 * twelve-place decimal rounds back to exactly that decimal.
 */
export function coordinateText(value: number): string {
  return value
    .toFixed(12)
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');
}

function parseWarehouse(values: InventoryFormValues): ParsedInventoryForm {
  const errors: InventoryErrors = {};
  const name = text(values, NAME_FIELD);
  if (name.length === 0) errors[NAME_FIELD] = INVENTORY_FORM_MESSAGES.nameMissing;
  else if (name.length > MAX_WAREHOUSE_NAME_LENGTH)
    errors[NAME_FIELD] = INVENTORY_FORM_MESSAGES.nameLong;
  else if (BIDI_CONTROL.test(name)) errors[NAME_FIELD] = INVENTORY_FORM_MESSAGES.characters;

  const latitude = coordinate(values[LATITUDE_FIELD] ?? '', 90);
  const longitude = coordinate(values[LONGITUDE_FIELD] ?? '', 180);
  if (latitude === null) errors[LATITUDE_FIELD] = INVENTORY_FORM_MESSAGES.latitude;
  if (longitude === null) errors[LONGITUDE_FIELD] = INVENTORY_FORM_MESSAGES.longitude;
  if ((latitude === 'EMPTY') !== (longitude === 'EMPTY')) {
    if (latitude === 'EMPTY') errors[LATITUDE_FIELD] = INVENTORY_FORM_MESSAGES.bothCoordinates;
    if (longitude === 'EMPTY') errors[LONGITUDE_FIELD] = INVENTORY_FORM_MESSAGES.bothCoordinates;
  }
  if (Object.keys(errors).length > 0) return { ok: false, fieldErrors: errors, message: null };
  const location =
    typeof latitude === 'number' && typeof longitude === 'number' ? { latitude, longitude } : null;
  return { ok: true, body: { name, location } };
}

function optionalReference(
  values: InventoryFormValues,
  name: string,
  pattern: RegExp,
  message: string,
  errors: InventoryErrors,
): string | null {
  const typed = identifier(values, name);
  if (typed === '') return null;
  if (!pattern.test(typed)) errors[name] = message;
  return typed;
}

function parseReceipt(values: InventoryFormValues): ParsedInventoryForm {
  const errors: InventoryErrors = {};
  const productId = identifier(values, PRODUCT_FIELD);
  if (!PRODUCT_ID_PATTERN.test(productId)) errors[PRODUCT_FIELD] = INVENTORY_FORM_MESSAGES.product;
  const quantity = wholeNumber(values[QUANTITY_FIELD] ?? '', MAX_STOCK_QUANTITY);
  if (quantity === null) errors[QUANTITY_FIELD] = INVENTORY_FORM_MESSAGES.quantity;
  const sourceReference = optionalReference(
    values,
    SOURCE_FIELD,
    SOURCE_REFERENCE_PATTERN,
    INVENTORY_FORM_MESSAGES.source,
    errors,
  );
  if (Object.keys(errors).length > 0 || quantity === null) {
    return { ok: false, fieldErrors: errors, message: null };
  }
  return { ok: true, body: { productId, quantity, sourceReference } };
}

function parseAdjustment(values: InventoryFormValues): ParsedInventoryForm {
  const errors: InventoryErrors = {};
  const stockItemId = identifier(values, STOCK_ITEM_FIELD);
  if (!STOCK_ITEM_ID_PATTERN.test(stockItemId))
    errors[STOCK_ITEM_FIELD] = INVENTORY_FORM_MESSAGES.stockItem;
  const direction = values[DIRECTION_FIELD];
  if (!(DIRECTIONS as readonly (string | undefined)[]).includes(direction))
    errors[DIRECTION_FIELD] = INVENTORY_FORM_MESSAGES.direction;
  const amount = wholeNumber(values[AMOUNT_FIELD] ?? '', MAX_STOCK_QUANTITY);
  if (amount === null) errors[AMOUNT_FIELD] = INVENTORY_FORM_MESSAGES.quantity;
  const sourceReference = optionalReference(
    values,
    SOURCE_FIELD,
    SOURCE_REFERENCE_PATTERN,
    INVENTORY_FORM_MESSAGES.source,
    errors,
  );
  if (Object.keys(errors).length > 0 || amount === null) {
    return { ok: false, fieldErrors: errors, message: null };
  }
  return {
    ok: true,
    body: {
      stockItemId,
      quantityDelta: direction === 'DECREASE' ? -amount : amount,
      sourceReference,
    },
  };
}

/** The leg indexes a form carries, ascending. */
function legIndexes(values: InventoryFormValues): number[] {
  const found = new Set<number>();
  for (const name of Object.keys(values)) {
    const match = LEG_FIELD.exec(name);
    if (match) found.add(Number(match[1]));
  }
  return [...found].sort((a, b) => a - b);
}

function parseShipment(values: InventoryFormValues): ParsedInventoryForm {
  const errors: InventoryErrors = {};
  const consigneeOrganizationId = identifier(values, CONSIGNEE_FIELD);
  if (!CONSIGNEE_PATTERN.test(consigneeOrganizationId))
    errors[CONSIGNEE_FIELD] = INVENTORY_FORM_MESSAGES.consignee;
  const orderReference = optionalReference(
    values,
    ORDER_FIELD,
    ORDER_REFERENCE_PATTERN,
    INVENTORY_FORM_MESSAGES.orderReference,
    errors,
  );

  const indexes = legIndexes(values);
  const legs: ShipmentLegBody[] = [];
  indexes.forEach((index) => {
    const nameField = legField(index, 'carrierName');
    const referenceField = legField(index, 'carrierReference');
    const carrierName = text(values, nameField);
    const reference = (values[referenceField] ?? '').trim();
    // A leg left entirely blank is not a leg, unless it is the only one.
    if (carrierName === '' && reference === '' && indexes.length > 1) return;
    if (carrierName === '' || carrierName.length > MAX_CARRIER_NAME_LENGTH) {
      errors[nameField] = INVENTORY_FORM_MESSAGES.carrierName;
    } else if (BIDI_CONTROL.test(carrierName)) {
      errors[nameField] = INVENTORY_FORM_MESSAGES.characters;
    }
    if (reference.length > MAX_CARRIER_REFERENCE_LENGTH || CONTROL_CHARACTER.test(reference)) {
      errors[referenceField] = INVENTORY_FORM_MESSAGES.carrierReference;
    }
    legs.push({ carrierName, carrierReference: reference === '' ? null : reference });
  });

  if (Object.keys(errors).length > 0) return { ok: false, fieldErrors: errors, message: null };
  if (legs.length < 1 || legs.length > MAX_SHIPMENT_LEGS) {
    return { ok: false, fieldErrors: errors, message: INVENTORY_FORM_MESSAGES.legs };
  }
  return { ok: true, body: { consigneeOrganizationId, orderReference, legs } };
}

/**
 * The values, into exactly what the command's schema takes. The shipment moves
 * (dispatch, delivery) have no fields; their whole body is the version the
 * page showed, carried by the signed stamp.
 */
export function parseInventoryForm(
  command: InventoryCommand,
  values: InventoryFormValues,
): ParsedInventoryForm {
  switch (command) {
    case 'CREATE_WAREHOUSE':
      return parseWarehouse(values);
    case 'RECEIVE_STOCK':
      return parseReceipt(values);
    case 'ADJUST_STOCK':
      return parseAdjustment(values);
    case 'CREATE_SHIPMENT':
      return parseShipment(values);
    case 'DISPATCH_SHIPMENT':
    case 'DELIVER_SHIPMENT':
      return { ok: false, fieldErrors: {}, message: null };
  }
}

/** Whether a command is typed (has fields) or only moves a shipment. */
export function hasFields(command: InventoryCommand): boolean {
  return command !== 'DISPATCH_SHIPMENT' && command !== 'DELIVER_SHIPMENT';
}

/** A kept body as the form's values again, for the hidden fields of a retry. */
export function valuesOfBody(command: InventoryCommand, body: InventoryBody): InventoryFormValues {
  const values: Record<string, string> = {};
  const put = (name: string, value: string | number | null) => {
    if (value !== null) values[name] = String(value);
  };
  switch (command) {
    case 'CREATE_WAREHOUSE': {
      const kept = body as WarehouseBody;
      put(NAME_FIELD, kept.name);
      put(LATITUDE_FIELD, kept.location ? coordinateText(kept.location.latitude) : null);
      put(LONGITUDE_FIELD, kept.location ? coordinateText(kept.location.longitude) : null);
      break;
    }
    case 'RECEIVE_STOCK': {
      const kept = body as ReceiptBody;
      put(PRODUCT_FIELD, kept.productId);
      put(QUANTITY_FIELD, kept.quantity);
      put(SOURCE_FIELD, kept.sourceReference);
      break;
    }
    case 'ADJUST_STOCK': {
      const kept = body as AdjustmentBody;
      put(STOCK_ITEM_FIELD, kept.stockItemId);
      put(DIRECTION_FIELD, kept.quantityDelta < 0 ? 'DECREASE' : 'INCREASE');
      put(AMOUNT_FIELD, Math.abs(kept.quantityDelta));
      put(SOURCE_FIELD, kept.sourceReference);
      break;
    }
    case 'CREATE_SHIPMENT': {
      const kept = body as ShipmentBody;
      put(CONSIGNEE_FIELD, kept.consigneeOrganizationId);
      put(ORDER_FIELD, kept.orderReference);
      kept.legs.forEach((leg, index) => {
        put(legField(index, 'carrierName'), leg.carrierName);
        put(legField(index, 'carrierReference'), leg.carrierReference);
      });
      break;
    }
    case 'DISPATCH_SHIPMENT':
    case 'DELIVER_SHIPMENT':
      break;
  }
  return values;
}

// ---------------------------------------------------------------------------
// Words for what the API returns
// ---------------------------------------------------------------------------

export const SHIPMENT_STATUS_LABELS: Readonly<Record<string, string>> = {
  CREATED: 'ایجادشده، هنوز ارسال نشده',
  DISPATCHED: 'ارسال‌شده، در راه',
  DELIVERED: 'تحویل‌شده',
};

/** A status this portal does not know is shown as it arrived, never guessed (`lib/labels.ts`). */
export function shipmentStatusLabel(status: string): string {
  return SHIPMENT_STATUS_LABELS[status] ?? status;
}

export const MOVEMENT_TYPE_LABELS: Readonly<Record<string, string>> = {
  RECEIPT: 'رسید',
  RESERVE: 'رزرو',
  RELEASE: 'آزادسازی رزرو',
  ISSUE: 'خروج با رزرو',
  ADJUSTMENT: 'اصلاح',
};

export function movementTypeLabel(type: string): string {
  return MOVEMENT_TYPE_LABELS[type] ?? type;
}

/** The person recorded on a movement is shown as a role of the system only when it is the service itself. */
export const SYSTEM_MOVEMENT_ACTOR = 'inventory-service';

// ---------------------------------------------------------------------------
// Refusals, in fixed words — never the service's own sentence
// ---------------------------------------------------------------------------

/**
 * Every refusal the three controllers document (`docs/api/inventory-service.openapi.json`):
 * 400 `VALIDATION_FAILED`; 403 (a form of its own); 404 (a form of its own);
 * 409 `IDEMPOTENCY_KEY_REUSED`, `CONFLICT`, `OPTIMISTIC_LOCK_FAILED` and
 * `INVALID_STATE_TRANSITION`; 422 `BUSINESS_RULE_VIOLATION`. The closed reason
 * rides in `details[].code` and is said in these words; a sentence of the
 * service is never rendered.
 */
export const INVENTORY_REFUSAL_TEXT = {
  VALIDATION: 'اطلاعات واردشده پذیرفته نشد؛ فیلدها را بررسی کنید. چیزی ثبت نشد.',
  ON_HAND_WOULD_BE_NEGATIVE:
    'موجودی نمی‌تواند از صفر یا از مقدار رزروشده کمتر شود. مقدار کمتری وارد کنید. چیزی ثبت نشد.',
  QUANTITY_OUT_OF_RANGE:
    'موجودی پس از این کار از بیشترین مقداری که سامانه نگه می‌دارد بیشتر می‌شود. چیزی ثبت نشد.',
  SHIPMENT_NOT_CREATED:
    'این محموله پیش‌تر ارسال یا تحویل شده است. صفحه را تازه کنید. چیزی ثبت نشد.',
  SHIPMENT_NOT_DISPATCHED:
    'این محموله هنوز ارسال نشده یا پیش‌تر تحویل شده است. صفحه را تازه کنید. چیزی ثبت نشد.',
  WRONG_STATE: 'وضعیت این مورد با آنچه در صفحه بود فرق کرده است. صفحه را تازه کنید. چیزی ثبت نشد.',
  OTHER_RULE: 'این کار با قواعد انبار سازگار نیست و ثبت نشد. صفحه را تازه کنید.',
  CHANGED: 'این مورد هم‌زمان تغییر کرد. صفحه را تازه کنید و دوباره بسنجید. چیزی ثبت نشد.',
  KEY_REUSED:
    'این فرم پیش‌تر با محتوای دیگری فرستاده شده بود و ممکن است ثبت شده باشد. صفحه را تازه کنید و وضعیت را ببینید.',
  ALREADY_FILED:
    'درخواست دیگری با همین ارسال انجام شده یا هنوز در حال انجام است. صفحه را تازه کنید و وضعیت را ببینید.',
  FALLBACK: 'این درخواست پذیرفته نشد و ثبت نشد. صفحه را تازه کنید و دوباره بسنجید.',
} as const;

export const INVENTORY_FORBIDDEN_TEXT =
  'این اقدام در اختیار سازمان یا نقش شما نیست و چیزی ثبت نشد.';

export const INVENTORY_NOT_FOUND_TEXT =
  'این انبار، کالا یا محموله دیگر در دسترس نیست. صفحه را تازه کنید.';

/** Said in place of the forms to a caller whose roles the service would refuse. */
export const INVENTORY_READ_ONLY_NOTE =
  'ثبت رسید، اصلاح موجودی و کار با محموله فقط برای اپراتور انبار سازمان است. نقش شما فقط خواندن را باز می‌کند.';

/** Said in place of the dispatch and delivery forms to the consignee (Q-114). */
export const INVENTORY_CONSIGNEE_NOTE =
  'این محموله به سازمان شما فرستاده شده است. گیرنده فقط وضعیت و پیگیری آن را می‌بیند؛ ارسال و تحویل را اپراتور سازمان صاحب انبار مبدا ثبت می‌کند.';

/** Said when the shipment has reached its last status. */
export const INVENTORY_SHIPMENT_FINISHED_NOTE = 'این محموله تحویل شده است و کار دیگری ندارد.';

/** Said when the stock of a warehouse could not be read, so no stock item can be offered to adjust. */
export const INVENTORY_NO_STOCK_FOR_ADJUSTMENT =
  'برای اصلاح موجودی باید کالایی در این انبار ثبت شده باشد. ابتدا رسید کالا ثبت کنید.';
