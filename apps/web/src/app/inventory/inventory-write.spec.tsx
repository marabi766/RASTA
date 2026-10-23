import { render, screen, within } from '@testing-library/react';
import { axe } from 'jest-axe';

import { INVENTORY_DONE_MESSAGES, INVENTORY_READ_ONLY_NOTE } from '@/lib/inventory-commands';
import type {
  MovementPage,
  MovementSummary,
  ReadResult,
  ShipmentPage,
  ShipmentSummary,
  StockItemSummary,
  StockPage,
  WarehousePage,
  WarehouseSummary,
} from '@/server/inventory';

import {
  InventoryScreen,
  type InventoryScreenProps,
  type InventorySelection,
  type InventoryWriteView,
} from './InventoryScreen';

/**
 * `/inventory` with its commands and its ledger: every state a viewer can be in
 * — operator, reader without the operator role, service degraded, nothing to
 * show — with the forms the page chose to draw. The actions are never reached
 * here (`inventory-actions.spec.ts`, `inventory-retry.spec.tsx`).
 */

jest.mock('./inventory-actions', () => ({ submitInventoryCommand: jest.fn() }));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const ULID = '01HZZZZZZZZZZZZZZZZZZZZZZZ';
const WAREHOUSE_ID = `WHS_${ULID}`;
const SHIPMENT_ID = `SHP_${ULID}`;

const WAREHOUSE: WarehouseSummary = {
  id: WAREHOUSE_ID,
  name: 'انبار مرکزی',
  createdAt: '2026-09-19T08:00:00.000Z',
};

const ITEM: StockItemSummary = {
  id: `SKI_${ULID}`,
  warehouseId: WAREHOUSE_ID,
  productId: `PRD_${ULID}`,
  onHandQuantity: 120,
  reservedQuantity: 20,
  availableQuantity: 100,
  updatedAt: '2026-09-20T08:00:00.000Z',
};

const MOVEMENT: MovementSummary = {
  id: 'MOV_1',
  stockItemId: ITEM.id,
  type: 'ADJUSTMENT',
  onHandDelta: -5,
  reservedDelta: 0,
  onHandAfter: 115,
  reservedAfter: 20,
  itemVersion: 4,
  reservationId: null,
  sourceReference: `ADJ_${ULID}`,
  createdAt: '2026-09-20T08:00:00.000Z',
  bySystem: false,
};

const SHIPMENT: ShipmentSummary = {
  id: SHIPMENT_ID,
  organizationId: 'ORG-DEH-0001',
  originWarehouseId: WAREHOUSE_ID,
  consigneeOrganizationId: 'ORG-DEH-0002',
  orderReference: null,
  status: 'DISPATCHED',
  legs: [{ sequence: 1, carrierName: 'باربری', carrierReference: null }],
  createdAt: '2026-09-19T08:00:00.000Z',
  dispatchedAt: '2026-09-20T08:00:00.000Z',
  deliveredAt: null,
  version: 2,
};

const page = <T,>(
  items: T[],
  nextCursor: string | null = null,
): ReadResult<{
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}> => ({ kind: 'OK', data: { items, nextCursor, hasMore: nextCursor !== null } });

const warehouses = (items: WarehouseSummary[]) => page(items) as ReadResult<WarehousePage>;
const stock = (items: StockItemSummary[]) => page(items) as ReadResult<StockPage>;
const movements = (items: MovementSummary[], next: string | null = null) =>
  page(items, next) as ReadResult<MovementPage>;
const shipments = (items: ShipmentSummary[], next: string | null = null) =>
  page(items, next) as ReadResult<ShipmentPage>;

const UNAVAILABLE = { kind: 'UNAVAILABLE', status: 503, correlationId: 'corr-1' } as const;
const MALFORMED = { kind: 'MALFORMED', correlationId: 'corr-1' } as const;
const OK_WAREHOUSE: ReadResult<WarehouseSummary> = { kind: 'OK', data: WAREHOUSE };

const STAMP = { token: 'stamp', until: Date.now() + 3_000_000 };
const offered = (
  command: 'CREATE_WAREHOUSE' | 'RECEIVE_STOCK' | 'ADJUST_STOCK' | 'CREATE_SHIPMENT',
) => ({
  command,
  submission: { id: `sub_${command}_KEYKEYKEYKEYKEYKEY`, replay: STAMP },
});

function write(overrides: Partial<InventoryWriteView> = {}): InventoryWriteView {
  return {
    canOperate: true,
    csrfToken: 'csrf',
    binding: { owner: 'owner-tag', session: 'session-tag' },
    sessionMaxAgeSeconds: 43_200,
    warehouseForms: [offered('CREATE_WAREHOUSE')],
    selectionForms: [offered('RECEIVE_STOCK'), offered('ADJUST_STOCK'), offered('CREATE_SHIPMENT')],
    pageHref: `/inventory?warehouse=${WAREHOUSE_ID}`,
    ...overrides,
  };
}

const chosen = (
  items: ReadResult<StockPage> = stock([ITEM]),
  ledger: ReadResult<MovementPage> | null = movements([MOVEMENT]),
): InventorySelection => ({ warehouse: OK_WAREHOUSE, stock: items, movements: ledger });

function props(overrides: Partial<InventoryScreenProps> = {}): InventoryScreenProps {
  return {
    warehouses: warehouses([WAREHOUSE]),
    selection: chosen(),
    query: { warehouse: WAREHOUSE_ID },
    shipments: shipments([SHIPMENT]),
    write: write(),
    ...overrides,
  };
}

/** The forms mount after the browser has been asked about an unresolved command. */
async function forms(name: string | RegExp) {
  return screen.findByRole('form', { name });
}

describe('an operator', () => {
  it('is offered every command the page chose, each its own form', async () => {
    render(<InventoryScreen {...props()} />);
    for (const name of [
      'ایجاد انبار',
      'ثبت رسید کالا',
      'اصلاح یا خروج مستقیم موجودی',
      'ایجاد محموله',
    ]) {
      expect(await forms(name)).toBeInTheDocument();
    }
    // No edit and no retire of a warehouse, no approval and no reservation commands.
    expect(screen.queryByRole('form', { name: /ویرایش|بستن|حذف|تایید|رزرو/ })).toBeNull();
  });

  it('an adjustment names the item and the direction, and says it has no reason and no second approval', async () => {
    render(<InventoryScreen {...props()} />);
    const form = await forms('اصلاح یا خروج مستقیم موجودی');
    expect(form).toHaveTextContent('دلیل یا تایید دوم نمی‌خواهد');
    const select = within(form).getByLabelText(/کالا/) as HTMLSelectElement;
    expect(select).toHaveTextContent(ITEM.productId);
    expect(within(form).getByLabelText(/نوع تغییر/)).toBeInTheDocument();
    expect(within(form).getByLabelText(/مقدار/)).toBeInTheDocument();
    expect(within(form).getByLabelText(/مرجع سند/)).toBeInTheDocument();
    expect(within(form).queryByLabelText(/دلیل|تاییدکننده/)).toBeNull();
  });

  it('a shipment form takes legs, one at first, and says what it does not do', async () => {
    render(<InventoryScreen {...props()} />);
    const form = await forms('ایجاد محموله');
    expect(within(form).getByLabelText(/سازمان گیرنده/)).toBeInTheDocument();
    expect(within(form).getAllByLabelText(/حمل‌کننده مرحله/)).toHaveLength(1);
    expect(form).toHaveTextContent('موجودی را کم نمی‌کند');
  });

  it('a warehouse with no stock is told so, and is not offered an adjustment', async () => {
    render(
      <InventoryScreen
        {...props({
          selection: chosen(stock([])),
          write: write({ selectionForms: [offered('RECEIVE_STOCK'), offered('CREATE_SHIPMENT')] }),
        })}
      />,
    );
    expect(await forms('ثبت رسید کالا')).toBeInTheDocument();
    expect(screen.getByText(/ابتدا رسید کالا ثبت کنید/)).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'اصلاح یا خروج مستقیم موجودی' })).toBeNull();
  });

  it('a signed confirmation is shown as success', async () => {
    render(<InventoryScreen {...props({ write: write({ notice: 'RECEIVE_STOCK' }) })} />);
    expect(await screen.findByText(INVENTORY_DONE_MESSAGES.RECEIVE_STOCK)).toBeInTheDocument();
  });

  it('an empty list of warehouses still offers the first one', async () => {
    render(
      <InventoryScreen
        {...props({ warehouses: warehouses([]), selection: null, shipments: shipments([]) })}
      />,
    );
    expect(await forms('ایجاد انبار')).toBeInTheDocument();
    expect(screen.getByText('این سازمان هنوز انباری ثبت نکرده است.')).toBeInTheDocument();
    expect(screen.getByText('محموله‌ای نیست')).toBeInTheDocument();
  });
});

describe('a viewer the service would refuse', () => {
  it('is drawn no form and told, in fixed words, that the role only reads', () => {
    render(
      <InventoryScreen
        {...props({
          write: write({ canOperate: false, warehouseForms: [], selectionForms: [] }),
        })}
      />,
    );
    expect(screen.queryByRole('form')).toBeNull();
    expect(screen.getAllByText(INVENTORY_READ_ONLY_NOTE).length).toBeGreaterThan(0);
  });

  it('a read-only screen without the write view draws no command and no note at all', () => {
    render(<InventoryScreen {...props({ write: undefined })} />);
    expect(screen.queryByRole('form')).toBeNull();
    expect(screen.queryByText(INVENTORY_READ_ONLY_NOTE)).toBeNull();
  });
});

describe('the service degraded or refusing', () => {
  it.each([UNAVAILABLE, MALFORMED])('offers no warehouse form while the list is %s', (result) => {
    render(<InventoryScreen {...props({ warehouses: result, selection: null })} />);
    expect(screen.queryByRole('form')).toBeNull();
    expect(screen.getByText(/فهرست انبارها خوانده نشد/)).toBeInTheDocument();
  });

  it.each([UNAVAILABLE, MALFORMED, { kind: 'FORBIDDEN' } as const])(
    'offers no stock form while the stock is %s',
    (result) => {
      render(<InventoryScreen {...props({ selection: chosen(result) })} />);
      expect(screen.queryByRole('form', { name: 'ثبت رسید کالا' })).toBeNull();
      expect(screen.queryByRole('form', { name: 'ایجاد محموله' })).toBeNull();
    },
  );

  it('a warehouse that is another organization’s (404) shows neither forms nor ledger', () => {
    render(
      <InventoryScreen
        {...props({
          selection: { warehouse: { kind: 'NOT_FOUND' }, stock: null, movements: null },
        })}
      />,
    );
    expect(screen.getByText('انبار یافت نشد')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'ثبت رسید کالا' })).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('the ledger', () => {
  it('shows each movement with its type, signed change, balance after, reference and date', () => {
    render(<InventoryScreen {...props({ write: undefined })} />);
    const table = screen.getByRole('table', { name: 'حرکت‌های موجودی انبار' });
    const cells = within(within(table).getAllByRole('row')[1]!).getAllByRole('cell');
    expect(cells[0]).toHaveTextContent('اصلاح');
    expect(cells[2]).toHaveTextContent('−۵');
    expect(cells[3]).toHaveTextContent('۱۱۵');
    expect(cells[4]).toHaveTextContent(`ADJ_${ULID}`);
    expect(cells[5]).toHaveTextContent(/۱۴۰۵/);
    for (const cell of [cells[2]!, cells[3]!]) expect(cell.textContent).not.toMatch(/[0-9]/);
  });

  it('marks a movement the service wrote itself, writes a gain with a plus and a missing reference as a dash', () => {
    render(
      <InventoryScreen
        {...props({
          write: undefined,
          selection: chosen(
            stock([ITEM]),
            movements([
              { ...MOVEMENT, id: 'M2', type: 'RECEIPT', onHandDelta: 7, sourceReference: null },
              { ...MOVEMENT, id: 'M3', type: 'RELEASE', onHandDelta: 0, bySystem: true },
            ]),
          ),
        })}
      />,
    );
    const rows = within(screen.getByRole('table', { name: 'حرکت‌های موجودی انبار' })).getAllByRole(
      'row',
    );
    expect(rows[1]).toHaveTextContent('رسید');
    expect(rows[1]).toHaveTextContent('+۷');
    expect(rows[1]).toHaveTextContent('—');
    expect(rows[2]).toHaveTextContent('خودکار');
    expect(rows[2]).toHaveTextContent('۰');
  });

  it('pages, keeping the warehouse', () => {
    render(
      <InventoryScreen
        {...props({
          write: undefined,
          selection: chosen(stock([ITEM]), movements([MOVEMENT], 'MOV_0')),
        })}
      />,
    );
    expect(screen.getByRole('link', { name: 'حرکت‌های قدیمی‌تر' })).toHaveAttribute(
      'href',
      `/inventory?warehouse=${WAREHOUSE_ID}&mcursor=MOV_0`,
    );
  });

  it('says so when nothing moved, and when it cannot be read or may not be', () => {
    const { rerender } = render(
      <InventoryScreen {...props({ selection: chosen(stock([ITEM]), movements([])) })} />,
    );
    expect(screen.getByText('حرکتی ثبت نشده')).toBeInTheDocument();
    rerender(<InventoryScreen {...props({ selection: chosen(stock([ITEM]), UNAVAILABLE) })} />);
    expect(screen.getByText(/دفتر حرکت موجودی خوانده نشد/)).toBeInTheDocument();
    expect(screen.getByText(/corr-1/)).toBeInTheDocument();
    rerender(
      <InventoryScreen {...props({ selection: chosen(stock([ITEM]), { kind: 'FORBIDDEN' }) })} />,
    );
    expect(screen.getByText('دفتر حرکت موجودی این انبار در اختیار شما نیست.')).toBeInTheDocument();
  });
});

describe('the shipments', () => {
  it('lists each with a link to its page, its status in words, and the two ends', () => {
    render(<InventoryScreen {...props({ write: undefined })} />);
    expect(screen.getByRole('link', { name: SHIPMENT_ID })).toHaveAttribute(
      'href',
      `/inventory/shipments/${SHIPMENT_ID}`,
    );
    expect(screen.getByText('ارسال‌شده، در راه')).toBeInTheDocument();
    expect(screen.getByText('ORG-DEH-0002')).toBeInTheDocument();
  });

  it('pages, keeping everything else in the query', () => {
    render(
      <InventoryScreen
        {...props({
          write: undefined,
          shipments: shipments([SHIPMENT], 'SHP_0'),
          query: { warehouse: WAREHOUSE_ID, cursor: 'c' },
        })}
      />,
    );
    expect(screen.getByRole('link', { name: 'محموله‌های بعدی' })).toHaveAttribute(
      'href',
      `/inventory?warehouse=${WAREHOUSE_ID}&cursor=c&scursor=SHP_0`,
    );
  });

  it('says so when there are none, and when the list is refused, absent or degraded', () => {
    const { rerender } = render(<InventoryScreen {...props({ shipments: shipments([]) })} />);
    expect(screen.getByText('محموله‌ای نیست')).toBeInTheDocument();
    rerender(<InventoryScreen {...props({ shipments: { kind: 'FORBIDDEN' } })} />);
    expect(screen.getByText('محموله‌های این سازمان در اختیار شما نیست.')).toBeInTheDocument();
    rerender(<InventoryScreen {...props({ shipments: UNAVAILABLE })} />);
    expect(screen.getByText(/فهرست محموله‌ها خوانده نشد/)).toBeInTheDocument();
    rerender(<InventoryScreen {...props({ shipments: MALFORMED })} />);
    expect(screen.getByText(/فهرست محموله‌ها خوانده نشد/)).toBeInTheDocument();
    rerender(<InventoryScreen {...props({ shipments: { kind: 'NOT_FOUND' } })} />);
    expect(screen.queryByRole('heading', { name: 'محموله‌ها' })).toBeNull();
  });
});

// One test per state: each axe run gets the whole default timeout to itself.
describe('accessibility', () => {
  const states: [string, InventoryScreenProps][] = [
    ['an operator, everything offered', props()],
    ['an operator, notice shown', props({ write: write({ notice: 'CREATE_WAREHOUSE' }) })],
    [
      'an operator, empty stock',
      props({
        selection: chosen(stock([])),
        write: write({ selectionForms: [offered('RECEIVE_STOCK'), offered('CREATE_SHIPMENT')] }),
      }),
    ],
    [
      'a reader without the operator role',
      props({ write: write({ canOperate: false, warehouseForms: [], selectionForms: [] }) }),
    ],
    ['ledger empty', props({ selection: chosen(stock([ITEM]), movements([])) })],
    ['ledger refused', props({ selection: chosen(stock([ITEM]), { kind: 'FORBIDDEN' }) })],
    ['ledger unavailable', props({ selection: chosen(stock([ITEM]), UNAVAILABLE) })],
    ['shipments empty', props({ shipments: shipments([]) })],
    ['shipments refused', props({ shipments: { kind: 'FORBIDDEN' } })],
    ['shipments unavailable', props({ shipments: UNAVAILABLE })],
    ['shipments malformed', props({ shipments: MALFORMED })],
    [
      'everything degraded',
      props({ warehouses: UNAVAILABLE, selection: null, shipments: UNAVAILABLE }),
    ],
  ];

  it.each(states)('has no violations (%s)', async (_name, state) => {
    const { container } = render(<InventoryScreen {...state} />);
    if (state.write?.canOperate) await forms('ثبت رسید کالا').catch(() => undefined);
    expect(await axe(container)).toHaveNoViolations();
  });
});
