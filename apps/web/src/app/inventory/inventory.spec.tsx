import { render, screen, within } from '@testing-library/react';
import { axe } from 'jest-axe';

import { formatQuantity, isWarehouseId } from '@/lib/inventory-fields';
import type {
  ReadResult,
  StockItemSummary,
  StockPage,
  WarehousePage,
  WarehouseSummary,
} from '@/server/inventory';

import { InventoryScreen, inventoryHref, type InventorySelection } from './InventoryScreen';
import { TEST_CONTEXT } from '@/test/page-context';
import { withContext } from '@/lib/page-context';

/**
 * What `/inventory` renders: every outcome the server reads can hand back
 * (empty, permission, degraded, absent) for the warehouse list and for the
 * stock of the chosen warehouse, quantities as Persian digits from whole
 * numbers, Jalali dates, and no raw service text.
 */

// A plain anchor: `next/link` prefetches through an intersection observer whose
// state updates land outside `act` and drown the output in warnings.
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const WAREHOUSE_ID = 'WHS_01HZZZZZZZZZZZZZZZZZZZZZZZ';

const WAREHOUSE: WarehouseSummary = {
  id: WAREHOUSE_ID,
  name: 'انبار مرکزی',
  createdAt: '2026-09-19T08:00:00.000Z',
};

const ITEM: StockItemSummary = {
  id: 'SKI_1',
  warehouseId: WAREHOUSE_ID,
  productId: 'PRD_1',
  onHandQuantity: 1234567,
  reservedQuantity: 34,
  availableQuantity: 1234533,
  updatedAt: '2026-09-20T08:00:00.000Z',
};

const warehouses = (
  items: WarehouseSummary[],
  nextCursor: string | null = null,
): ReadResult<WarehousePage> => ({
  kind: 'OK',
  data: { items, nextCursor, hasMore: nextCursor !== null },
});

const stock = (items: StockItemSummary[], nextCursor: string | null = null) =>
  ({
    kind: 'OK',
    data: { items, nextCursor, hasMore: nextCursor !== null },
  }) as ReadResult<StockPage>;

const selection = (
  warehouse: ReadResult<WarehouseSummary>,
  items: ReadResult<StockPage> | null,
): InventorySelection => ({ warehouse, stock: items });

const OK_WAREHOUSE: ReadResult<WarehouseSummary> = { kind: 'OK', data: WAREHOUSE };
const UNAVAILABLE = { kind: 'UNAVAILABLE', status: 503, correlationId: 'corr-1' } as const;
const MALFORMED = { kind: 'MALFORMED', correlationId: 'corr-1' } as const;

describe('quantities', () => {
  it('groups whole numbers as Persian digits and refuses anything else', () => {
    expect(formatQuantity(0)).toBe('۰');
    expect(formatQuantity(1234567)).toBe('۱٬۲۳۴٬۵۶۷');
    expect(formatQuantity(1234567)).not.toMatch(/[0-9]/);
    for (const bad of [1.5, -1, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => formatQuantity(bad)).toThrow(RangeError);
    }
  });

  it('forwards only an id shaped like a warehouse’s', () => {
    expect(isWarehouseId(WAREHOUSE_ID)).toBe(true);
    for (const bad of [
      undefined,
      '',
      'WHS_1',
      'SKI_01HZZZZZZZZZZZZZZZZZZZZZZZ',
      `${WAREHOUSE_ID}x`,
    ]) {
      expect(isWarehouseId(bad)).toBe(false);
    }
  });
});

describe('the warehouse list', () => {
  it('shows each warehouse with a link that chooses it, and its Jalali creation date', () => {
    render(
      <InventoryScreen
        warehouses={warehouses([WAREHOUSE])}
        selection={null}
        query={{ context: TEST_CONTEXT }}
      />,
    );

    expect(screen.getByRole('link', { name: 'انبار مرکزی' })).toHaveAttribute(
      'href',
      withContext(TEST_CONTEXT, `/inventory?warehouse=${WAREHOUSE_ID}`),
    );
    expect(screen.getByText(/۱۴۰۵/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('pages the warehouses without losing the chosen one', () => {
    render(
      <InventoryScreen
        warehouses={warehouses([WAREHOUSE], 'w2')}
        selection={null}
        query={{ context: TEST_CONTEXT, warehouse: WAREHOUSE_ID, cursor: 's3' }}
      />,
    );
    expect(screen.getByRole('link', { name: 'انبارهای بعدی' })).toHaveAttribute(
      'href',
      withContext(TEST_CONTEXT, `/inventory?warehouse=${WAREHOUSE_ID}&wcursor=w2&cursor=s3`),
    );
  });

  it('says so when there are none', () => {
    render(
      <InventoryScreen
        warehouses={warehouses([])}
        selection={null}
        query={{ context: TEST_CONTEXT }}
      />,
    );
    expect(screen.getByText('این سازمان هنوز انباری ثبت نکرده است.')).toBeInTheDocument();
  });

  it('renders a refusal as no access', () => {
    render(
      <InventoryScreen
        warehouses={{ kind: 'FORBIDDEN' }}
        selection={null}
        query={{ context: TEST_CONTEXT }}
      />,
    );
    expect(screen.getByText('انبارهای این سازمان در اختیار شما نیست.')).toBeInTheDocument();
  });

  it.each([UNAVAILABLE, MALFORMED])(
    'renders a degraded read ($kind) with the correlation id and fixed text',
    (result) => {
      render(
        <InventoryScreen warehouses={result} selection={null} query={{ context: TEST_CONTEXT }} />,
      );
      expect(screen.getByText(/فهرست انبارها خوانده نشد/)).toBeInTheDocument();
      expect(screen.getByText(/corr-1/)).toBeInTheDocument();
    },
  );

  it('builds links from the query alone', () => {
    expect(inventoryHref({ context: TEST_CONTEXT }, {})).toBe('/inventory');
    expect(
      inventoryHref(
        { context: TEST_CONTEXT, warehouse: WAREHOUSE_ID, cursor: 'c' },
        { warehouse: undefined },
      ),
    ).toBe(`/inventory?cursor=c&ctx=${TEST_CONTEXT}`);
  });
});

describe('the stock of the chosen warehouse', () => {
  const query = { context: TEST_CONTEXT, warehouse: WAREHOUSE_ID };

  it('shows on hand, reserved and available per item as Persian digits', () => {
    render(
      <InventoryScreen
        warehouses={warehouses([WAREHOUSE])}
        selection={selection(OK_WAREHOUSE, stock([ITEM]))}
        query={query}
      />,
    );

    const table = screen.getByRole('table', { name: 'موجودی کالاها در انبار' });
    const row = within(table).getAllByRole('row')[1] as HTMLElement;
    const cells = within(row).getAllByRole('cell');
    expect(cells[0]).toHaveTextContent('PRD_1');
    expect(cells[1]).toHaveTextContent('۱٬۲۳۴٬۵۶۷');
    expect(cells[2]).toHaveTextContent('۳۴');
    expect(cells[3]).toHaveTextContent('۱٬۲۳۴٬۵۳۳');
    // Every figure and the date are Persian digits; only the opaque id is Latin.
    for (const cell of cells.slice(1)) expect(cell.textContent).not.toMatch(/[0-9]/);
    expect(screen.getByRole('heading', { name: /موجودی انبار/ })).toBeInTheDocument();
  });

  it('pages the stock and keeps the chosen warehouse in the link', () => {
    render(
      <InventoryScreen
        warehouses={warehouses([WAREHOUSE])}
        selection={selection(OK_WAREHOUSE, stock([ITEM], 'SKI_2'))}
        query={query}
      />,
    );
    expect(screen.getByRole('link', { name: 'صفحهٔ بعد' })).toHaveAttribute(
      'href',
      withContext(TEST_CONTEXT, `/inventory?warehouse=${WAREHOUSE_ID}&cursor=SKI_2`),
    );
  });

  it('says so when the warehouse holds nothing', () => {
    render(
      <InventoryScreen
        warehouses={warehouses([WAREHOUSE])}
        selection={selection(OK_WAREHOUSE, stock([]))}
        query={query}
      />,
    );
    expect(screen.getByText('در این انبار هنوز کالایی ثبت نشده است.')).toBeInTheDocument();
  });

  it('renders an unknown warehouse as absent, without its stock', () => {
    render(
      <InventoryScreen
        warehouses={warehouses([WAREHOUSE])}
        selection={selection({ kind: 'NOT_FOUND' }, null)}
        query={query}
      />,
    );
    expect(screen.getByText('انبار درخواستی در این سازمان نیست.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders a refusal of the warehouse or of its stock as no access', () => {
    const { rerender } = render(
      <InventoryScreen
        warehouses={warehouses([WAREHOUSE])}
        selection={selection({ kind: 'FORBIDDEN' }, null)}
        query={query}
      />,
    );
    expect(screen.getByText('موجودی این انبار در اختیار شما نیست.')).toBeInTheDocument();

    rerender(
      <InventoryScreen
        warehouses={warehouses([WAREHOUSE])}
        selection={selection(OK_WAREHOUSE, { kind: 'FORBIDDEN' })}
        query={query}
      />,
    );
    expect(screen.getByText('موجودی این انبار در اختیار شما نیست.')).toBeInTheDocument();
  });

  it.each([UNAVAILABLE, MALFORMED])(
    'renders a degraded stock read ($kind) with fixed text and the correlation id',
    (result) => {
      render(
        <InventoryScreen
          warehouses={warehouses([WAREHOUSE])}
          selection={selection(OK_WAREHOUSE, result)}
          query={query}
        />,
      );
      expect(screen.getByText(/موجودی انبار خوانده نشد/)).toBeInTheDocument();
      expect(screen.getByText(/corr-1/)).toBeInTheDocument();
    },
  );

  it.each([UNAVAILABLE, MALFORMED])(
    'renders a degraded warehouse read ($kind) with fixed text and no stock',
    (result) => {
      render(
        <InventoryScreen
          warehouses={warehouses([WAREHOUSE])}
          selection={selection(result, null)}
          query={query}
        />,
      );
      expect(screen.getByText(/انبار خوانده نشد/)).toBeInTheDocument();
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
    },
  );
});

// One test per state: each axe run gets the whole default timeout to itself.
// All sixteen in one test overran the 5 s default on a loaded CI runner (main
// run 38715938220), while one state takes about a tenth of a second here.
describe('accessibility', () => {
  const query = { context: TEST_CONTEXT, warehouse: WAREHOUSE_ID };
  const chosen = (picked: InventorySelection): Parameters<typeof InventoryScreen>[0] => ({
    warehouses: warehouses([WAREHOUSE]),
    selection: picked,
    query,
  });

  it.each<[string, Parameters<typeof InventoryScreen>[0]]>([
    [
      'warehouses, more to page',
      {
        warehouses: warehouses([WAREHOUSE], 'w2'),
        selection: null,
        query: { context: TEST_CONTEXT },
      },
    ],
    [
      'no warehouses',
      { warehouses: warehouses([]), selection: null, query: { context: TEST_CONTEXT } },
    ],
    [
      'warehouses refused',
      { warehouses: { kind: 'FORBIDDEN' }, selection: null, query: { context: TEST_CONTEXT } },
    ],
    [
      'warehouses not found',
      { warehouses: { kind: 'NOT_FOUND' }, selection: null, query: { context: TEST_CONTEXT } },
    ],
    [
      'warehouses unavailable',
      { warehouses: UNAVAILABLE, selection: null, query: { context: TEST_CONTEXT } },
    ],
    [
      'warehouses malformed',
      { warehouses: MALFORMED, selection: null, query: { context: TEST_CONTEXT } },
    ],
    ['stock, more to page', chosen(selection(OK_WAREHOUSE, stock([ITEM], 'SKI_2')))],
    ['no stock', chosen(selection(OK_WAREHOUSE, stock([])))],
    ['stock refused', chosen(selection(OK_WAREHOUSE, { kind: 'FORBIDDEN' }))],
    ['stock not found', chosen(selection(OK_WAREHOUSE, { kind: 'NOT_FOUND' }))],
    ['stock unavailable', chosen(selection(OK_WAREHOUSE, UNAVAILABLE))],
    ['stock malformed', chosen(selection(OK_WAREHOUSE, MALFORMED))],
    ['warehouse refused', chosen(selection({ kind: 'FORBIDDEN' }, null))],
    ['warehouse not found', chosen(selection({ kind: 'NOT_FOUND' }, null))],
    ['warehouse unavailable', chosen(selection(UNAVAILABLE, null))],
    ['warehouse malformed', chosen(selection(MALFORMED, null))],
  ])('has no violations (%s)', async (_name, props) => {
    const { container } = render(<InventoryScreen {...props} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
