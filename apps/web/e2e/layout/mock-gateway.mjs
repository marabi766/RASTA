/**
 * A stand-in for the API gateway, for the phone-layout suite only.
 *
 * The portal's pages read their data on the server, so a browser test cannot
 * intercept those requests: the portal under test is pointed at this process
 * instead of a live stack (`playwright.config.ts`, `e2e/layout/harness.ts`).
 * It answers GET only, with **populated** pages — rows as long as the real
 * ones (twenty-six-character ids, full Persian titles, nine-digit rial
 * amounts) — because a layout test against an empty table proves nothing about
 * a table's width. Everything else is a 404 in the platform's error envelope.
 *
 * It holds no session, no tenant and no authority: it is a fixture server for
 * a throwaway portal on a loopback port, never a gateway.
 */
/* global process, URL, console */
import { createServer } from 'node:http';

const PORT = Number(process.env.LAYOUT_GATEWAY_PORT ?? 3291);

const ORG = 'ORG-LAYOUT-0001';
const SUPPLIERS = ['ORG-DEH-0002', 'ORG-DEH-0003', 'ORG_01J9ZK4W8Q2M6R1T5V7X3C9B0D', ORG];
const ID = (prefix, n) => `${prefix}_01J9ZK4W8Q2M6R1T5V7X3C${String(n).padStart(4, '0')}`;
const ISO = (day) => new Date(Date.UTC(2026, 8, 10 + day, 8, 30)).toISOString();

const wallet = {
  id: ID('WAL', 1),
  organizationId: ORG,
  currency: 'IRR',
  status: 'ACTIVE',
  ledgerBalanceMinor: '48250000000',
  pendingBalanceMinor: '12500000000',
  availableBalanceMinor: '35750000000',
  createdAt: ISO(0),
  updatedAt: ISO(5),
};

const holds = Array.from({ length: 3 }, (_, i) => ({
  id: ID('HLD', i + 1),
  walletId: wallet.id,
  amountMinor: String(4_150_000_000 + i * 125_000_000),
  currency: 'IRR',
  status: 'ACTIVE',
  reference: ID('ORD', i + 1),
  referenceType: 'ORDER',
  placedAt: ISO(i),
  resolvedAt: null,
  resolutionNote: null,
}));

const STATUSES = ['HELD', 'SETTLED', 'PENDING_SETTLEMENT', 'CREATED', 'HELD', 'DISPUTED'];
const transactions = STATUSES.map((status, i) => ({
  id: ID('TXN', i + 1),
  transactionType: i % 2 === 0 ? 'MARKETPLACE_ORDER' : 'MAINTENANCE_SERVICE',
  status,
  grossAmountMinor: String(4_150_000_000 + i * 125_000_000),
  netAmountMinor: status === 'SETTLED' ? '4000000000' : '0',
  currency: 'IRR',
  occurredAt: ISO(i),
  sourceType: 'ORDER',
  sourceReference: ID('ORD', i + 1),
  disputeReason: null,
  settledAt: status === 'SETTLED' ? ISO(i + 1) : null,
  failureReason: null,
}));

const offer = (productId, i) => ({
  id: ID('OFR', i + 1),
  productId,
  supplierOrganizationId: SUPPLIERS[i % SUPPLIERS.length],
  unitPriceMinor: String(1_850_000 + i * 75_000),
  currency: 'IRR',
  availableQuantity: 1200 + i * 35,
  leadTimeDays: 3 + i,
  minimumQuantity: 10 + i,
  supplierQualification: 'UNAVAILABLE',
});

const product = (id, n) => ({
  id,
  sku: `SKU-HYD-${String(n).padStart(5, '0')}`,
  name: `شیلنگ هیدرولیک صنعتی فشار قوی نوع ${n} با اتصال دوسر فلزی`,
  description: 'مناسب ماشین‌آلات سنگین راهسازی و کشاورزی',
  category: 'قطعات یدکی',
  kind: 'GOOD',
  unit: 'عدد',
  offers: Array.from({ length: 3 }, (_, i) => offer(id, i)),
});

const PRODUCT_ID = ID('PRD', 1);
const products = Array.from({ length: 6 }, (_, i) =>
  product(i === 0 ? PRODUCT_ID : ID('PRD', i + 1), i + 1),
);

const requests = Array.from({ length: 8 }, (_, i) => ({
  id: ID('MNT', i + 1),
  assetId: ID('AST', i + 1),
  scheduleId: null,
  type: i % 2 === 0 ? 'CORRECTIVE' : 'PREVENTIVE',
  status: ['REPORTED', 'APPROVED', 'IN_PROGRESS', 'COMPLETED'][i % 4],
  severity: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'][i % 4],
  title: `نشت روغن از پمپ هیدرولیک بیل مکانیکی شمارهٔ ${i + 1} در کارگاه خاکبرداری`,
  reportedAt: ISO(i),
  dueDate: ISO(i + 6),
  totalCostMinor: String(18_500_000_000 + i * 250_000_000),
}));

const drivers = Array.from({ length: 5 }, (_, i) => ({
  id: ID('DRV', i + 1),
  userId: ID('USR', i + 1),
  employeeNo: `OP-${115 + i}`,
  licenceNumber: `1402${String(7_700_000 + i)}`,
  licenceClass: ['پایه دوم', 'پایه یک', 'پایه سوم', 'B2', 'پایه ویژه'][i],
  licenceValidTo: ISO(40 + i),
  status: 'ACTIVE',
}));

const order = {
  id: ID('ORD', 1),
  status: 'CONFIRMED',
  buyerOrganizationId: ORG,
  supplierOrganizationId: SUPPLIERS[0],
  totalAmountMinor: '9250000000',
  currency: 'IRR',
  lines: Array.from({ length: 3 }, (_, i) => ({
    id: ID('OLN', i + 1),
    offerId: ID('OFR', i + 1),
    productId: ID('PRD', i + 1),
    productName: `شیلنگ هیدرولیک صنعتی فشار قوی نوع ${i + 1} با اتصال دوسر فلزی`,
    quantity: 25 + i,
    unitPriceMinor: '1850000',
    lineTotalMinor: String((25 + i) * 1_850_000),
    currency: 'IRR',
  })),
  confirmedAt: ISO(1),
  fulfilledAt: null,
  receiptConfirmedAt: null,
  completedAt: null,
  cancelledAt: null,
  cancellationReason: null,
  failureReason: null,
  createdAt: ISO(0),
  availableActions: [],
};

/** Exact path → body. Query strings are ignored: the fixtures are the whole set. */
const ROUTES = new Map([
  ['/health', { ok: true }],
  ['/v1/wallets/me', wallet],
  [`/v1/wallets/${wallet.id}/holds`, { items: holds }],
  ['/v1/transactions', { items: transactions, nextCursor: null, hasMore: false }],
  ['/v1/wallets/provider', { provider: 'mock', simulated: true }],
  ['/v1/wallets/provider/disclosure', { provider: 'mock', simulated: true }],
  ['/v1/products', { items: products }],
  [`/v1/products/${PRODUCT_ID}`, products[0]],
  [`/v1/products/${PRODUCT_ID}/offers`, { items: products[0].offers }],
  ['/v1/maintenance-requests', { items: requests, nextCursor: null, hasMore: false }],
  ['/v1/drivers', { items: drivers, nextCursor: null, hasMore: false }],
  [`/v1/orders/${order.id}`, order],
]);

createServer((request, response) => {
  const { pathname } = new URL(request.url ?? '/', 'http://127.0.0.1');
  const body = request.method === 'GET' ? ROUTES.get(pathname) : undefined;
  response.setHeader('content-type', 'application/json');
  response.setHeader('x-correlation-id', 'COR_LAYOUT_FIXTURE');
  if (body === undefined) {
    // Said once per miss, so a page that needs a fixture this file lacks is findable.
    console.error(`mock-gateway: no fixture for ${request.method} ${pathname}`);
    response.statusCode = 404;
    response.end(
      JSON.stringify({ code: 'NOT_FOUND', message: 'No such fixture', statusCode: 404 }),
    );
    return;
  }
  response.end(JSON.stringify(body));
}).listen(PORT, '127.0.0.1');
