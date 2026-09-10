/**
 * The presentation dataset.
 *
 * ## What makes this safe to show
 *
 * Every record announces that it is invented. Names begin with «نمونه»,
 * identifiers carry a `demo` segment, and the one email address is on
 * `example.invalid` — a domain RFC 2606 reserves so it can never resolve to a
 * real person. Nothing here is copied from a real tenant, and there is no
 * token, password, national id, phone number or bank detail anywhere in the
 * file, because a fixture that imitates a credential is a credential as far as
 * a screenshot is concerned.
 *
 * ## Why it is one coherent story rather than per-screen samples
 *
 * The grader is in the workshop. That single fact has to hold on five different
 * screens: the asset list shows `IN_MAINTENANCE`, the dossier lists the two
 * blockers, fleet availability refuses to dispatch it and names the two
 * services that own those facts, the maintenance queue has the open request the
 * blocker refers to, and the timeline carries the event that put it there.
 *
 * Sampling each screen independently would produce a demo where a machine is
 * simultaneously available and under repair, and an audience notices that far
 * faster than anyone expects.
 *
 * ## Why it is loaded dynamically
 *
 * This module is only ever imported by `FixtureGatewayClient`, which itself is
 * only imported when the mode is `fixture`. A live build never pays for it —
 * ADR-003's 200 KiB budget has about ten kilobytes of headroom, and a dataset
 * this size would spend most of it on something a live deployment cannot use.
 */

import { FIXTURE_ENTRY_POINTS } from './entry-points';

const ORG_ALEF = 'org_demo_dehyari_alef';
const ORG_BEH = 'org_demo_dehyari_beh';
const ORG_WORKSHOP = 'org_demo_workshop';
const ORG_SUPPLIER = 'org_demo_supplier';

// The four ids the tour deep-links to live in their own module, so the tour can
// import them without pulling this dataset into a live build. They are still
// defined once: a link and the record it points at cannot drift apart.
const ASSET_GRADER = FIXTURE_ENTRY_POINTS.assetId;
const REQUEST_OIL = FIXTURE_ENTRY_POINTS.maintenanceRequestId;
const PRODUCT_OIL = FIXTURE_ENTRY_POINTS.productId;
const ORDER_OIL = FIXTURE_ENTRY_POINTS.orderId;

const ASSET_LOADER = 'ast_demo_loader';
const ASSET_TANKER = 'ast_demo_tanker';
const OFFER_OIL_A = 'ofr_demo_oil_a';
const OFFER_OIL_B = 'ofr_demo_oil_b';

/** Fixed timestamps. A demo that drifts with the clock is not reproducible. */
const T = {
  registered: '2024-04-12T08:00:00.000Z',
  commissioned: '2024-05-01T08:00:00.000Z',
  lastService: '2026-06-14T09:30:00.000Z',
  reported: '2026-08-30T06:15:00.000Z',
  assigned: '2026-08-30T09:00:00.000Z',
  ordered: '2026-09-01T11:20:00.000Z',
  now: '2026-09-05T12:00:00.000Z',
} as const;

const asset = (
  id: string,
  serial: string,
  name: string,
  type: string,
  status: string,
  tag: string | null,
  extra: Record<string, unknown> = {},
) => ({
  id,
  organizationId: ORG_ALEF,
  assetTag: tag,
  name,
  type,
  manufacturer: 'نمونه‌سازان',
  model: 'DEMO-100',
  serialNumber: `SN-DEMO-${serial}`,
  manufactureYear: 2019,
  status,
  commissionedAt: T.commissioned,
  decommissionedAt: null,
  specifications: {},
  createdAt: T.registered,
  updatedAt: T.now,
  ...extra,
});

const ASSETS = [
  asset(ASSET_GRADER, '0001', 'گریدر نمونه ۱', 'GRADER', 'IN_MAINTENANCE', '۱۲ ب ۳۴۵ ایران ۵۴'),
  asset(ASSET_LOADER, '0002', 'لودر نمونه ۲', 'LOADER', 'ACTIVE', '۱۷ ج ۸۸۱ ایران ۵۴'),
  asset(ASSET_TANKER, '0003', 'تانکر آب نمونه ۳', 'WATER_TANKER', 'IDLE', null),
];

/**
 * The two blockers on the grader.
 *
 * Written once and referenced by both the dossier and fleet availability, so
 * the two screens cannot disagree about why the machine is grounded.
 */
const GRADER_BLOCKERS = [
  'دستور کار تعمیر باز دارد و در تعمیرگاه است',
  'بیمه‌نامهٔ فعالی برای این ماشین ثبت نشده است',
] as const;

const TIMELINE = [
  {
    id: 'tl_demo_3',
    eventName: 'MAINTENANCE_REQUEST_ASSIGNED',
    sourceService: 'maintenance-service',
    category: 'MAINTENANCE',
    title: 'ارجاع به تعمیرگاه نمونه',
    description: 'درخواست تعویض روغن و فیلتر به تعمیرگاه ارجاع شد.',
    amountMinor: null,
    detail: {},
    occurredAt: T.assigned,
  },
  {
    id: 'tl_demo_2',
    eventName: 'MAINTENANCE_REQUESTED',
    sourceService: 'maintenance-service',
    category: 'MAINTENANCE',
    title: 'ثبت درخواست تعمیر',
    description: 'سررسید ساعت کارکرد گذشت و درخواست سرویس ثبت شد.',
    amountMinor: null,
    detail: {},
    occurredAt: T.reported,
  },
  {
    id: 'tl_demo_1',
    eventName: 'USAGE_RECORDED',
    sourceService: 'fleet-service',
    category: 'USAGE',
    title: 'ثبت کارکرد',
    description: 'کنتور ساعت‌کار از ۴٬۳۸۰٫۵۰ به ۴٬۳۸۶٫۵۰ رسید.',
    amountMinor: null,
    detail: {},
    occurredAt: '2026-08-29T14:00:00.000Z',
  },
];

const DOSSIER = {
  asset: ASSETS[0],
  organizationName: 'دهیاری نمونهٔ الف',
  currentLocation: {
    id: 'loc_demo_1',
    siteName: 'تعمیرگاه نمونهٔ مرکزی',
    addressLine: 'شهرک صنعتی نمونه، خیابان ۳',
    coordinate: null,
    source: 'MANUAL',
    recordedAt: T.assigned,
  },
  compliance: {
    operable: false,
    blockers: [...GRADER_BLOCKERS],
    activeInsurance: null,
    latestInspection: {
      id: 'insp_demo_1',
      certificateNo: 'CERT-DEMO-0042',
      centerName: 'مرکز معاینهٔ نمونه',
      inspectedAt: '2025-09-01T08:00:00.000Z',
      validTo: '2026-09-01T08:00:00.000Z',
      result: 'PASS',
      notes: null,
      // Negative: lapsed four days before the fixed "now".
      daysUntilExpiry: -4,
    },
  },
  costs: {
    totalMinor: '412500000',
    maintenanceMinor: '128500000',
    partsAndOrdersMinor: '284000000',
    entryCount: 6,
  },
  documents: [
    {
      id: 'adoc_demo_1',
      documentId: 'doc_demo_insurance',
      kind: 'INSURANCE_POLICY',
      title: 'بیمه‌نامهٔ نمونه — منقضی',
      issuedAt: '2025-09-01T00:00:00.000Z',
      expiresAt: '2026-09-01T00:00:00.000Z',
    },
  ],
  recentActivity: TIMELINE.slice(0, 2),
  transferCount: 0,
};

/** Availability, told from the same facts as the dossier. */
const AVAILABILITY = [
  {
    assetId: ASSET_GRADER,
    assetName: 'گریدر نمونه ۱',
    assetType: 'GRADER',
    assetTag: '۱۲ ب ۳۴۵ ایران ۵۴',
    available: false,
    blockers: [
      {
        code: 'IN_MAINTENANCE',
        owner: 'maintenance-service',
        detail: GRADER_BLOCKERS[0],
      },
      {
        code: 'DISPATCH_BLOCKED',
        owner: 'asset-service',
        detail: GRADER_BLOCKERS[1],
      },
    ],
    currentAssignment: null,
  },
  {
    assetId: ASSET_LOADER,
    assetName: 'لودر نمونه ۲',
    assetType: 'LOADER',
    assetTag: '۱۷ ج ۸۸۱ ایران ۵۴',
    available: false,
    blockers: [
      {
        code: 'ACTIVE_ASSIGNMENT',
        owner: 'fleet-service',
        detail: 'به رانندهٔ نمونه تخصیص یافته و در حال کار است.',
      },
    ],
    currentAssignment: {
      id: 'asg_demo_1',
      driverId: 'drv_demo_1',
      startedAt: '2026-09-02T05:30:00.000Z',
    },
  },
  {
    assetId: ASSET_TANKER,
    assetName: 'تانکر آب نمونه ۳',
    assetType: 'WATER_TANKER',
    assetTag: null,
    available: true,
    blockers: [],
    currentAssignment: null,
  },
];

const UTILIZATION = {
  items: [
    {
      assetId: ASSET_LOADER,
      assetName: 'لودر نمونه ۲',
      from: '2026-08-06T00:00:00.000Z',
      to: T.now,
      usedHours: '96.50',
      kilometres: '0',
      availableHours: '160.00',
      utilizationPercent: '60.3',
      recordCount: 14,
      assignmentCount: 1,
    },
    {
      // Null, never zero. The tanker has no readings at all in the window, and
      // "we have no data" is a different fact from "the machine sat idle".
      assetId: ASSET_TANKER,
      assetName: 'تانکر آب نمونه ۳',
      from: '2026-08-06T00:00:00.000Z',
      to: T.now,
      usedHours: '0',
      kilometres: '0',
      availableHours: '160.00',
      utilizationPercent: null,
      recordCount: 0,
      assignmentCount: 0,
    },
  ],
  from: '2026-08-06T00:00:00.000Z',
  to: T.now,
};

const DRIVERS = [
  {
    id: 'drv_demo_1',
    organizationId: ORG_ALEF,
    userId: 'usr_demo_driver',
    employeeNo: 'EMP-DEMO-01',
    licenceNumber: 'LIC-DEMO-0001',
    licenceClass: 'C1',
    licenceValidTo: '2027-03-01T00:00:00.000Z',
    status: 'ACTIVE',
    statusReason: null,
    notes: null,
    createdAt: T.registered,
    updatedAt: T.now,
  },
];

const ASSIGNMENTS = [
  {
    id: 'asg_demo_1',
    organizationId: ORG_ALEF,
    driverId: 'drv_demo_1',
    assetId: ASSET_LOADER,
    active: true,
    startedAt: '2026-09-02T05:30:00.000Z',
    endedAt: null,
    purpose: 'عملیات نمونهٔ تسطیح',
    endReason: null,
    endNotes: null,
    assignedBy: 'usr_demo_presenter',
    endedBy: null,
  },
];

const USAGE_RECORDS = [
  {
    id: 'usg_demo_1',
    organizationId: ORG_ALEF,
    assetId: ASSET_GRADER,
    driverId: 'drv_demo_1',
    assignmentId: null,
    periodStart: '2026-08-29T05:00:00.000Z',
    periodEnd: '2026-08-29T14:00:00.000Z',
    hours: '6.00',
    kilometres: null,
    hourMeter: '4386.50',
    odometer: null,
    source: 'MANUAL',
    notes: null,
    clientReference: null,
    recordedAt: '2026-08-29T14:05:00.000Z',
  },
];

const DUE_SCHEDULE = {
  id: 'sch_demo_1',
  organizationId: ORG_ALEF,
  assetId: ASSET_GRADER,
  assetName: 'گریدر نمونه ۱',
  title: 'سرویس دوره‌ای ۲۵۰ ساعت',
  maintenanceType: 'PREVENTIVE',
  recurrence: 'RECURRING',
  status: 'ACTIVE',
  intervalDays: null,
  intervalHours: '250',
  intervalKilometres: null,
  leadDays: null,
  leadHours: '20',
  leadKilometres: null,
  lastServicedAt: T.lastService,
  lastServicedHourMeter: '4120.50',
  lastServicedOdometer: null,
  lastServiceRequestId: null,
  notes: null,
  createdAt: T.registered,
  updatedAt: T.now,
  due: {
    state: 'OVERDUE',
    basis: 'HOURS',
    dueBy: null,
    dueAtMeter: '4370.50',
    triggers: [
      {
        basis: 'HOURS',
        state: 'OVERDUE',
        dueAt: null,
        dueAtMeter: '4370.50',
        remaining: '-16.00',
      },
      {
        basis: 'TIME',
        state: 'NOT_DUE',
        dueAt: '2026-12-14T09:30:00.000Z',
        dueAtMeter: null,
        remaining: '100',
      },
    ],
  },
  meter: { hourMeter: '4386.50', odometer: '0', lastPeriodEnd: '2026-08-29T14:00:00.000Z' },
  openRequestId: REQUEST_OIL,
};

const MAINTENANCE_REQUEST = {
  id: REQUEST_OIL,
  organizationId: ORG_ALEF,
  assetId: ASSET_GRADER,
  scheduleId: 'sch_demo_1',
  type: 'PREVENTIVE',
  status: 'IN_PROGRESS',
  severity: null,
  title: 'تعویض روغن و فیلتر — سرویس ۲۵۰ ساعت',
  description: 'سررسید بر مبنای ساعت کارکرد گذشت.',
  reportedAt: T.reported,
  reportedBy: 'usr_demo_presenter',
  dueDate: null,
  outOfServiceAt: T.assigned,
  returnedToServiceAt: null,
  downtimeMinutes: null,
  startedAt: T.assigned,
  startedBy: 'usr_demo_presenter',
  completedAt: null,
  completedBy: null,
  // Not yet approved: approval is the control that permits settlement, and a
  // demo that shows it already granted skips the point of showing it.
  approvedAt: null,
  approvedBy: null,
  approvalNotes: null,
  cancelledAt: null,
  cancelledBy: null,
  cancellationReason: null,
  totalCostMinor: '128500000',
  currency: 'IRR',
};

const REPAIR_ORDER = {
  id: 'rep_demo_1',
  organizationId: ORG_ALEF,
  maintenanceRequestId: REQUEST_OIL,
  assetId: ASSET_GRADER,
  workshopOrganizationId: ORG_WORKSHOP,
  workshopName: 'تعمیرگاه نمونهٔ مرکزی',
  status: 'IN_PROGRESS',
  workSummary: 'تعویض روغن، فیلتر روغن و فیلتر هوا',
  workPerformed: null,
  assignedAt: T.assigned,
  assignedBy: 'usr_demo_presenter',
  startedAt: T.assigned,
  completedAt: null,
  cancelledAt: null,
  cancellationReason: null,
  partsCostMinor: '96500000',
  labourCostMinor: '32000000',
  otherCostMinor: '0',
  totalCostMinor: '128500000',
  currency: 'IRR',
};

const offer = (id: string, supplier: string, price: string, lead: number, quantity: number) => ({
  id,
  productId: PRODUCT_OIL,
  supplierOrganizationId: supplier,
  unitPriceMinor: price,
  currency: 'IRR',
  availableQuantity: quantity,
  leadTimeDays: lead,
  minimumQuantity: 1,
  status: 'PUBLISHED',
  version: 1,
  // Never a boolean. Nothing has checked, and `false` would report a verdict.
  supplierQualification: 'UNAVAILABLE' as const,
});

const OFFERS = [
  offer(OFFER_OIL_A, ORG_SUPPLIER, '142000000', 4, 30),
  offer(OFFER_OIL_B, ORG_WORKSHOP, '152000000', 2, 12),
];

const PRODUCT = {
  id: PRODUCT_OIL,
  sku: 'SKU-DEMO-OIL-208',
  name: 'روغن موتور دیزل نمونه — بشکهٔ ۲۰۸ لیتری',
  description: 'کالای نمونه برای ارائه. این ردیف دادهٔ واقعی هیچ سازمانی نیست.',
  category: 'روان‌کار',
  kind: 'GOOD',
  unit: 'بشکه',
  status: 'ACTIVE',
  offers: OFFERS,
};

const ORDER = {
  id: ORDER_OIL,
  status: 'FUNDS_HELD',
  buyerOrganizationId: ORG_ALEF,
  supplierOrganizationId: ORG_SUPPLIER,
  totalAmountMinor: '284000000',
  currency: 'IRR',
  lines: [
    {
      offerId: OFFER_OIL_A,
      productId: PRODUCT_OIL,
      productName: 'روغن موتور دیزل نمونه — بشکهٔ ۲۰۸ لیتری',
      quantity: 2,
      unitPriceMinor: '142000000',
      lineTotalMinor: '284000000',
      currency: 'IRR',
      offerVersion: 1,
    },
  ],
  economicTransactionId: 'txn_demo_order',
  economicSettlementId: null,
  supplierQualification: 'UNAVAILABLE' as const,
  reminderCount: 1,
  lastReminderAt: '2026-09-04T11:20:00.000Z',
  confirmedAt: null,
  fulfilledAt: null,
  receiptConfirmedAt: null,
  completedAt: null,
  cancelledAt: null,
  cancellationReason: null,
  failureReason: null,
  createdAt: T.ordered,
  placedBy: 'usr_demo_presenter',
};

/**
 * The wallet, arithmetically consistent with the order above.
 *
 * `pending` is exactly the order's total, because that order is in `FUNDS_HELD`
 * and its hold is the only commitment in this dataset. `available` is
 * `ledger − pending`, which the real service enforces with a database
 * constraint — a fixture that broke it would be demonstrating a system that
 * cannot exist.
 */
const WALLET = {
  id: 'wal_demo_1',
  organizationId: ORG_ALEF,
  currency: 'IRR',
  status: 'ACTIVE',
  ledgerBalanceMinor: '1150400000',
  pendingBalanceMinor: '284000000',
  availableBalanceMinor: '866400000',
  createdAt: T.registered,
  updatedAt: T.now,
};

const TRANSACTIONS = [
  {
    id: 'txn_demo_order',
    organizationId: ORG_ALEF,
    counterpartyOrganizationId: ORG_SUPPLIER,
    transactionType: 'ORDER_PAYMENT',
    status: 'HELD',
    grossAmountMinor: '284000000',
    // Zero because no commission rule matched — Q-08 is open and no rate is
    // approved. The screen renders that reason rather than the number.
    commissionAmountMinor: '0',
    netAmountMinor: '284000000',
    currency: 'IRR',
    occurredAt: T.ordered,
    sourceType: 'ORDER',
    sourceReference: ORDER_OIL,
    disputedAt: null,
    disputeReason: null,
    settledAt: null,
    failureReason: null,
    createdAt: T.ordered,
    createdBy: 'usr_demo_presenter',
  },
  {
    id: 'txn_demo_topup',
    organizationId: ORG_ALEF,
    counterpartyOrganizationId: null,
    transactionType: 'WALLET_TOP_UP',
    status: 'SETTLED',
    grossAmountMinor: '1150400000',
    commissionAmountMinor: '0',
    netAmountMinor: '1150400000',
    currency: 'IRR',
    occurredAt: '2026-08-01T08:00:00.000Z',
    sourceType: 'PAYMENT_INTENT',
    sourceReference: 'pmi_demo_1',
    disputedAt: null,
    disputeReason: null,
    settledAt: '2026-08-01T08:00:05.000Z',
    failureReason: null,
    createdAt: '2026-08-01T08:00:00.000Z',
    createdBy: 'economic-service',
  },
];

const LEDGER_ACCOUNTS = [
  {
    id: 'acc_demo_wallet',
    organizationId: ORG_ALEF,
    accountType: 'LIABILITY',
    accountCode: '2100-WALLET',
    purpose: 'WALLET',
    currency: 'IRR',
    status: 'ACTIVE',
    title: 'کیف پول دهیاری نمونهٔ الف',
  },
  {
    id: 'acc_demo_escrow',
    organizationId: ORG_ALEF,
    accountType: 'LIABILITY',
    accountCode: '2200-ESCROW',
    purpose: 'ESCROW',
    currency: 'IRR',
    status: 'ACTIVE',
    title: 'امانی دهیاری نمونهٔ الف',
  },
];

/** Debits equal credits. A demonstration ledger that did not balance would be
 *  showing the exact alarm the real one raises. */
const TRIAL_BALANCE = {
  currency: 'IRR',
  totalDebitMinor: '1150400000',
  totalCreditMinor: '1150400000',
  balanced: true,
  accounts: [
    {
      accountId: 'acc_demo_wallet',
      accountCode: '2100-WALLET',
      accountType: 'LIABILITY',
      organizationId: ORG_ALEF,
      currency: 'IRR',
      debitMinor: '0',
      creditMinor: '866400000',
      balanceMinor: '866400000',
    },
    {
      accountId: 'acc_demo_escrow',
      accountCode: '2200-ESCROW',
      accountType: 'LIABILITY',
      organizationId: ORG_ALEF,
      currency: 'IRR',
      debitMinor: '0',
      creditMinor: '284000000',
      balanceMinor: '284000000',
    },
    {
      accountId: 'acc_demo_clearing',
      accountCode: '1100-CLEARING',
      accountType: 'ASSET',
      organizationId: 'org_demo_platform',
      currency: 'IRR',
      debitMinor: '1150400000',
      creditMinor: '0',
      balanceMinor: '1150400000',
    },
  ],
};

const document_ = (
  id: string,
  filename: string,
  documentClass: string,
  scanState: 'PENDING' | 'NOT_SCANNED' | 'CLEAN' | 'INFECTED' | 'FAILED',
  extra: Record<string, unknown> = {},
) => ({
  id,
  organizationId: ORG_ALEF,
  documentClass,
  status: 'REGISTERED' as const,
  contentType: 'application/pdf',
  sizeBytes: 184320,
  filename,
  scanState,
  scanInspectedContent: scanState === 'CLEAN' || scanState === 'INFECTED',
  scanEngine: scanState === 'PENDING' || scanState === 'NOT_SCANNED' ? null : 'clamav',
  scanSignatureVersion: scanState === 'CLEAN' ? '27142' : null,
  scanSignature: null,
  scanFailureReason: null,
  quarantinedAt: null,
  scannedAt: scanState === 'CLEAN' ? '2026-09-01T08:10:00.000Z' : null,
  ownerResourceType: null,
  ownerResourceId: null,
  createdAt: '2026-09-01T08:00:00.000Z',
  createdBy: 'usr_demo_presenter',
  deletedAt: null,
  deletionReason: null,
  ...extra,
});

/**
 * Three documents in three different scan states.
 *
 * Chosen so the screen can show what it is for: `CLEAN` is downloadable,
 * `PENDING` is a scan that has not finished, and `NOT_SCANNED` is a file no
 * engine ever looked at. The last two are both undownloadable for entirely
 * different reasons, which is the distinction the column exists to preserve.
 */
const DOCUMENTS = [
  document_('doc_demo_contract', 'قرارداد-نمونه.pdf', 'CONTRACT', 'CLEAN'),
  document_('doc_demo_insurance', 'بیمه‌نامه-نمونه.pdf', 'INSURANCE_POLICY', 'PENDING'),
  document_('doc_demo_report', 'گزارش-بازدید-نمونه.pdf', 'INSPECTION_REPORT', 'NOT_SCANNED'),
];

const SUPPLIERS = [
  {
    id: 'sup_demo_1',
    organizationId: ORG_SUPPLIER,
    displayName: 'بازرگانی نمونهٔ یزد',
    status: 'ACTIVE',
    capabilities: ['GOODS_SUPPLY'],
    qualifiedFor: ['GOODS_SUPPLY'],
    registeredAt: '2026-02-01T00:00:00.000Z',
  },
  {
    id: 'sup_demo_2',
    organizationId: ORG_WORKSHOP,
    displayName: 'تعمیرگاه نمونهٔ مرکزی',
    status: 'ACTIVE',
    capabilities: ['WORKSHOP_SERVICE', 'GOODS_SUPPLY'],
    // Claims two, qualified for one — the distinction the screen is built on.
    qualifiedFor: ['WORKSHOP_SERVICE'],
    registeredAt: '2026-03-15T00:00:00.000Z',
  },
];

const organization = (id: string, name: string, depth: number, parentId: string | null) => ({
  id,
  externalCode: null,
  name,
  shortName: null,
  type: 'DEHYARI',
  status: 'ACTIVE',
  parentId,
  path: null,
  depth,
  metadata: {},
  createdAt: T.registered,
  updatedAt: T.now,
});

const ORGANIZATIONS = [
  organization('org_demo_union', 'اتحادیهٔ نمونهٔ استان', 0, null),
  organization(ORG_ALEF, 'دهیاری نمونهٔ الف', 1, 'org_demo_union'),
  organization(ORG_BEH, 'دهیاری نمونهٔ ب', 1, 'org_demo_union'),
];

const CURRENT_USER = {
  id: 'usr_demo_presenter',
  username: 'demo.presenter',
  email: 'presenter@example.invalid',
  firstName: 'کاربر',
  lastName: 'نمایشی',
  phone: null,
  status: 'ACTIVE',
  activeOrganizationId: ORG_ALEF,
  createdAt: T.registered,
  updatedAt: T.now,
  effectiveRoles: ['ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'PROCUREMENT_USER'],
  memberships: [
    {
      id: 'mem_demo_1',
      organizationId: ORG_ALEF,
      organizationName: 'دهیاری نمونهٔ الف',
      roles: ['ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'PROCUREMENT_USER'],
      status: 'ACTIVE',
      validFrom: T.registered,
      validUntil: null,
    },
    {
      id: 'mem_demo_2',
      organizationId: ORG_BEH,
      organizationName: 'دهیاری نمونهٔ ب',
      roles: ['ORGANIZATION_ADMIN'],
      status: 'ACTIVE',
      validFrom: T.registered,
      validUntil: null,
    },
  ],
};

const ORGANIZATION_USERS = [
  {
    ...CURRENT_USER,
    memberships: undefined,
    effectiveRoles: undefined,
    roles: CURRENT_USER.effectiveRoles,
  },
  {
    id: 'usr_demo_driver',
    username: 'demo.driver',
    email: 'driver@example.invalid',
    firstName: 'رانندهٔ',
    lastName: 'نمونه',
    phone: null,
    status: 'ACTIVE',
    activeOrganizationId: ORG_ALEF,
    createdAt: T.registered,
    updatedAt: T.now,
    roles: ['DRIVER'],
  },
];

const cursorPage = (items: unknown[]) => ({ items, nextCursor: null, hasMore: false });
const shortPage = (items: unknown[]) => ({ items, nextCursor: null });

/**
 * The routing table.
 *
 * Keyed by the gateway path an adapter actually calls, so adding a screen that
 * reads a new route produces a loud "no fixture" failure rather than a silently
 * empty page that looks like a legitimate empty state.
 */
export const FIXTURE_RESPONSES: Readonly<Record<string, unknown>> = {
  // identity + organization
  '/v1/users/me': CURRENT_USER,
  '/v1/users': cursorPage(ORGANIZATION_USERS),
  '/v1/organizations': cursorPage(ORGANIZATIONS),

  // asset
  '/v1/assets': cursorPage(ASSETS),
  [`/v1/assets/${ASSET_GRADER}/dossier`]: DOSSIER,
  [`/v1/assets/${ASSET_GRADER}/timeline`]: cursorPage(TIMELINE),

  // fleet
  '/v1/fleet/availability': cursorPage(AVAILABILITY),
  '/v1/fleet/utilization': UTILIZATION,
  '/v1/drivers': cursorPage(DRIVERS),
  '/v1/assignments': cursorPage(ASSIGNMENTS),
  '/v1/usage-records': cursorPage(USAGE_RECORDS),

  // maintenance
  '/v1/maintenance-schedules/due': cursorPage([DUE_SCHEDULE]),
  '/v1/maintenance-requests': cursorPage([MAINTENANCE_REQUEST]),
  [`/v1/maintenance-requests/${REQUEST_OIL}`]: {
    ...MAINTENANCE_REQUEST,
    repairOrders: [REPAIR_ORDER],
    costBreakdown: [
      { category: 'PART', amountMinor: '96500000', currency: 'IRR' },
      { category: 'LABOUR', amountMinor: '32000000', currency: 'IRR' },
    ],
  },
  '/v1/repair-orders': cursorPage([REPAIR_ORDER]),

  // marketplace
  '/v1/products': { items: [PRODUCT] },
  [`/v1/products/${PRODUCT_OIL}/offers`]: { items: OFFERS },
  '/v1/orders': shortPage([ORDER]),
  [`/v1/orders/${ORDER_OIL}`]: ORDER,

  // economic
  '/v1/wallets/me': WALLET,
  '/v1/wallets/provider': {
    provider: 'mock',
    simulated: true,
    notice: 'Simulated payment provider. No bank connection, no real funds, no custody of money.',
  },
  '/v1/transactions': cursorPage(TRANSACTIONS),
  '/v1/ledger/accounts': { items: LEDGER_ACCOUNTS },
  '/v1/ledger/trial-balance': TRIAL_BALANCE,

  // document + supplier
  '/v1/documents': shortPage(DOCUMENTS),
  '/v1/suppliers': cursorPage(SUPPLIERS),
};
