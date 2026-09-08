import { REGISTERED_ADAPTERS, type AdapterId } from './api/adapter-registry';

/**
 * The single source of truth for what this application claims to do.
 *
 * Navigation, the dashboard cards and the route guards all read this file, so
 * there is exactly one place where a capability's status can be stated — and
 * exactly one place to audit before a demo.
 *
 * ## Why the states are what they are
 *
 * The temptation in an investor build is a binary: things that work and things
 * that do not. That binary forces a lie in both directions. `asset-service` is
 * implemented, tested and live-verified upstream, so calling its screen
 * "planned" understates the platform; but this milestone ships no screen for
 * it, so calling it "live" overstates the frontend. `BACKEND_READY` is the
 * honest third answer, and it is the state most of the platform is in today.
 *
 * `LIVE` is the only state that makes a claim about *this* application, and it
 * is the only one with a machine-checkable precondition: a registered adapter
 * that talks to a real gateway route (`assertManifestIntegrity`).
 */

export const CAPABILITY_STATES = [
  /** An implemented backend route, reached by a registered adapter in this app. */
  'LIVE',
  /**
   * Implemented and merged upstream, but the domain phase is not finished.
   * Supplier Phase 1 shipped; performance scoring (COM-005) is `IN_PROGRESS`.
   */
  'BETA',
  /**
   * The backend capability exists and is verified; this milestone builds no
   * screen for it. Architecture-ready, not operational in this application.
   */
  'BACKEND_READY',
  /**
   * A visual or product preview. Nothing is operational and every surface
   * carrying it must say so — «PREVIEW — داده نمایشی، عملیات واقعی نیست».
   */
  'PREVIEW',
  /** No implementation anywhere. A gateway route, a topic or a design is not one. */
  'PLANNED',
] as const;

export type CapabilityState = (typeof CAPABILITY_STATES)[number];

/** Why a capability is not `LIVE`. Shown verbatim on the «در حال ساخت» screen. */
export type ReadinessReason =
  /** Backend contracts exist and are verified; the screen is the missing part. */
  | 'ARCHITECTURE_READY'
  /** Decided, not built. No service, no schema, no route handler. */
  | 'PLANNED'
  /** Waiting on a product or governance decision, not on engineering. */
  | 'BLOCKED_BY_PRODUCT_DECISION'
  /** Part of the domain shipped; the rest has not started. */
  | 'PARTIAL';

export interface Capability {
  /** Stable key. Used by routes, tests and the dashboard. */
  readonly key: string;
  /** The route this capability owns. Always a real, resolvable path. */
  readonly href: string;
  readonly title: string;
  readonly summary: string;
  readonly state: CapabilityState;
  /** Which backend service owns the data, or `null` where none exists yet. */
  readonly service: string | null;
  /** Required when — and only when — the state is `LIVE`. */
  readonly adapter?: AdapterId;
  /** Absent for `LIVE`, required otherwise. */
  readonly readiness?: ReadinessReason;
  /**
   * Where the claim comes from. A status with no citation is an opinion, and
   * this is the field a reviewer checks first.
   */
  readonly evidence: string;
  /** Grouping for the navigation rail. */
  readonly group: 'operations' | 'commerce' | 'finance' | 'platform';
}

/**
 * The manifest.
 *
 * Status here follows `PROJECT_MEMORY.md` § 3 and § 7 — the repository's own
 * record of what is implemented, tested and live-verified — never a gateway
 * route, a Kafka topic, a service scaffold or an approved design, none of
 * which are implementations.
 */
export const CAPABILITIES: readonly Capability[] = [
  {
    key: 'marketplace',
    href: '/marketplace',
    title: 'بازار و مقایسه پیشنهادها',
    summary: 'جست‌وجوی فهرست کالا و خدمت، و مقایسه پیشنهادهای منتشرشدهٔ تأمین‌کنندگان.',
    state: 'LIVE',
    service: 'marketplace-service',
    adapter: 'marketplace.catalogue',
    evidence:
      'services/marketplace-service/src/offer/catalogue.controller.ts — GET /v1/products، GET /v1/products/{id}/offers',
    group: 'commerce',
  },
  {
    key: 'organizations',
    href: '/organizations',
    title: 'سازمان و انتخاب مستأجر',
    summary: 'سازمان‌های قابل مشاهده، و انتخاب سازمان فعال از میان عضویت‌های واقعی کاربر.',
    state: 'LIVE',
    service: 'organization-service',
    adapter: 'organization.directory',
    evidence:
      'services/organization-service/src/organization/organization.controller.ts — GET /v1/organizations',
    group: 'platform',
  },
  {
    key: 'wallet-disclosure',
    href: '/wallet',
    title: 'افشای ارائه‌دهندهٔ پرداخت',
    summary: 'اینکه کدام ارائه‌دهندهٔ پرداخت پیکربندی شده و آیا پول واقعی جابه‌جا می‌کند.',
    state: 'LIVE',
    service: 'economic-service',
    adapter: 'economic.paymentProvider',
    evidence:
      'services/economic-service/src/wallet/wallet.controller.ts — GET /v1/wallets/provider (ADR-024)',
    group: 'finance',
  },

  // ---- implemented upstream, no screen in this milestone -------------------
  {
    key: 'assets',
    href: '/assets',
    title: 'ماشین‌آلات و پروندهٔ الکترونیکی',
    summary: 'ثبت دارایی، اسناد، بیمه‌نامه و بازدید؛ به‌همراه خط زمانی دارایی.',
    state: 'BACKEND_READY',
    service: 'asset-service',
    readiness: 'ARCHITECTURE_READY',
    evidence: 'PROJECT_MEMORY.md § ۷ — asset-service: IMPLEMENTED، ۷۴ تست واحد، در CI Matrix',
    group: 'operations',
  },
  {
    key: 'fleet',
    href: '/fleet',
    title: 'راننده، تخصیص و ثبت کارکرد',
    summary: 'راننده، تخصیص انحصاری، رکورد کارکرد و دسترس‌پذیری ناوگان.',
    state: 'BACKEND_READY',
    service: 'fleet-service',
    readiness: 'ARCHITECTURE_READY',
    evidence: 'PROJECT_MEMORY.md § ۷-الف — IMPLEMENTED · TESTED · LIVE VERIFIED · CI VERIFIED',
    group: 'operations',
  },
  {
    key: 'maintenance',
    href: '/maintenance',
    title: 'نگهداری و تعمیرات',
    summary: 'برنامهٔ سرویس، درخواست تعمیر، دستور کار و هزینهٔ تأییدشده.',
    state: 'BACKEND_READY',
    service: 'maintenance-service',
    readiness: 'ARCHITECTURE_READY',
    evidence: 'PROJECT_MEMORY.md § ۷-ب — IMPLEMENTED · TESTED · LIVE VERIFIED · CI VERIFIED',
    group: 'operations',
  },
  {
    key: 'orders',
    href: '/orders',
    title: 'سفارش‌ها',
    summary: 'چرخهٔ عمر سفارش از ثبت تا تسویه، با گردش‌کار Temporal و تأیید دریافت.',
    state: 'BACKEND_READY',
    service: 'marketplace-service',
    readiness: 'ARCHITECTURE_READY',
    evidence:
      'services/marketplace-service/src/order/order.controller.ts؛ PROJECT_MEMORY.md § ۳ — ۱۷ سناریوی E2E',
    group: 'commerce',
  },
  {
    key: 'documents',
    href: '/documents',
    title: 'اسناد',
    summary: 'آپلود مستقیم به Object Storage، اسکن بدافزار و دانلود Fail-Closed.',
    state: 'BACKEND_READY',
    service: 'document-service',
    readiness: 'ARCHITECTURE_READY',
    evidence: 'PROJECT_MEMORY.md § ۷-د — IMPLEMENTED · TESTED · LIVE VERIFIED (ADR-049)',
    group: 'platform',
  },
  {
    key: 'identity',
    href: '/users',
    title: 'کاربران، نقش و عضویت',
    summary: 'کاربر، اعتبارنامه، عضویت سازمانی و نقش‌های دامنه‌ای.',
    state: 'BACKEND_READY',
    service: 'identity-service',
    readiness: 'ARCHITECTURE_READY',
    evidence: 'PROJECT_MEMORY.md § ۷ — identity-service: IMPLEMENTED، در CI Matrix',
    group: 'platform',
  },
  {
    key: 'wallet-ledger',
    href: '/wallet/ledger',
    title: 'کیف پول، تراکنش و دفتر کل',
    summary: 'مانده، تعهد، تسویه و دفتر کل دوطرفهٔ تغییرناپذیر.',
    state: 'BACKEND_READY',
    service: 'economic-service',
    readiness: 'ARCHITECTURE_READY',
    evidence: 'PROJECT_MEMORY.md § ۷-ج — ۳۰۸ واحد + ۲۵۵ یکپارچگی + ۳۷ E2E، LIVE VERIFIED',
    group: 'finance',
  },

  // ---- partially shipped ---------------------------------------------------
  {
    key: 'suppliers',
    href: '/suppliers',
    title: 'تأمین‌کنندگان',
    summary:
      'فاز ۱ (پروفایل، احراز صلاحیت، تعلیق، فهرست) روی main است. امتیاز عملکرد پیاده نشده؛ COM-005 هنوز IN_PROGRESS است.',
    state: 'BETA',
    service: 'supplier-service',
    readiness: 'PARTIAL',
    evidence:
      'PROJECT_MEMORY.md § ۳ — supplier-service فاز ۱ Merge شد (36d718cf)؛ Phase 2 شروع نشده، COM-005 IN_PROGRESS',
    group: 'commerce',
  },

  // ---- not implemented -----------------------------------------------------
  {
    key: 'procurement',
    href: '/procurement',
    title: 'تأمین، تجمیع تقاضا و استعلام',
    summary: 'ثبت نیاز، تجمیع، استعلام و سفارش خرید.',
    state: 'PLANNED',
    service: null,
    readiness: 'PLANNED',
    evidence:
      'services/ ندارد. مسیر `demand-requests` در جدول Gateway هست اما سرویسی پشت آن ساخته نشده.',
    group: 'commerce',
  },
  {
    key: 'inventory',
    href: '/inventory',
    title: 'انبار، موجودی و حمل',
    summary: 'انبار، موجودی، حرکت کالا و محموله.',
    state: 'PLANNED',
    service: null,
    readiness: 'PLANNED',
    evidence:
      'ADR-041 § 2 — رزرو موجودی وجود ندارد؛ `availableQuantity` اعلام تأمین‌کننده است، نه موجودی انبار.',
    group: 'commerce',
  },
  {
    key: 'construction',
    href: '/projects',
    title: 'پروژه‌های عمرانی و مناقصه',
    summary: 'پروژه، نیاز، گردش موافقت، مناقصه، پیشنهاد و پیشرفت.',
    state: 'PLANNED',
    service: null,
    readiness: 'PLANNED',
    evidence: 'PROJECT_MEMORY.md § ۷ — construction-service: NOT_STARTED',
    group: 'operations',
  },
  {
    key: 'contracts',
    href: '/contracts',
    title: 'قرارداد و صورت‌وضعیت',
    summary: 'قرارداد، الحاقیه، صورت‌وضعیت و نقطهٔ عطف.',
    state: 'PLANNED',
    service: null,
    readiness: 'PLANNED',
    evidence: 'PROJECT_MEMORY.md § ۷ — contract-service: NOT_STARTED',
    group: 'operations',
  },
  {
    key: 'notifications',
    href: '/notifications',
    title: 'اعلان‌ها',
    summary: 'اعلان، قالب، تحویل و ترجیح کاربر.',
    state: 'PLANNED',
    service: null,
    readiness: 'PLANNED',
    evidence:
      'در main فقط Bootstrap سرویس Merge شده (PR #38). هیچ دامنه‌ای پیاده نشده و هیچ اعلانی تحویل نمی‌شود.',
    group: 'platform',
  },
  {
    key: 'audit',
    href: '/audit',
    title: 'سوابق حسابرسی',
    summary: 'رویداد حسابرسی، فقط الحاقی.',
    state: 'PLANNED',
    service: null,
    readiness: 'PLANNED',
    evidence: 'در main فقط Bootstrap سرویس Merge شده (PR #38). AuditEvent پیاده نشده.',
    group: 'platform',
  },
  {
    key: 'analytics',
    href: '/reports',
    title: 'گزارش و داشبورد تحلیلی',
    summary: 'مدل خواندنی و عکس فوری شاخص‌ها.',
    state: 'PLANNED',
    service: null,
    readiness: 'PLANNED',
    evidence:
      'PROJECT_MEMORY.md § ۷ — analytics-service: NOT_STARTED. هیچ KPI عملیاتی در این نسخه محاسبه نمی‌شود.',
    group: 'platform',
  },
  {
    key: 'returns',
    href: '/returns',
    title: 'مرجوعی و لجستیک معکوس',
    summary: 'مرجوعی، ضمانت و حمل برگشت.',
    state: 'PLANNED',
    service: null,
    readiness: 'BLOCKED_BY_PRODUCT_DECISION',
    evidence: 'ADR-048 — مرز لجستیک معکوس ثبت شده اما هیچ سرویسی آن را پیاده نکرده است.',
    group: 'commerce',
  },
];

export class ManifestIntegrityError extends Error {
  constructor(readonly violations: string[]) {
    super(`Capability manifest is dishonest:\n  - ${violations.join('\n  - ')}`);
    this.name = 'ManifestIntegrityError';
  }
}

/**
 * Refuses a manifest that claims more than the code delivers.
 *
 * This is the whole reason the manifest is data rather than JSX scattered
 * across pages. A `LIVE` badge is a factual claim about a network call this
 * application actually makes; the check below is what stops it from becoming a
 * label somebody typed.
 *
 * Runs at module load *and* in the test suite, so a dishonest manifest cannot
 * reach a running page even if a test were skipped.
 */
export function assertManifestIntegrity(
  capabilities: readonly Capability[] = CAPABILITIES,
  registered: ReadonlySet<string> = REGISTERED_ADAPTERS,
): void {
  const violations: string[] = [];
  const seen = new Set<string>();

  for (const capability of capabilities) {
    if (seen.has(capability.key)) violations.push(`duplicate capability key "${capability.key}"`);
    seen.add(capability.key);

    if (!capability.href.startsWith('/')) {
      violations.push(`"${capability.key}" has a non-absolute href "${capability.href}"`);
    }

    if (capability.state === 'LIVE') {
      if (!capability.adapter) {
        violations.push(`"${capability.key}" is LIVE with no adapter named`);
      } else if (!registered.has(capability.adapter)) {
        violations.push(
          `"${capability.key}" is LIVE and names adapter "${capability.adapter}", ` +
            'which is not registered — nothing in this application calls it',
        );
      }
      if (!capability.service) {
        violations.push(`"${capability.key}" is LIVE with no owning service`);
      }
      if (capability.readiness) {
        violations.push(`"${capability.key}" is LIVE and also carries a readiness reason`);
      }
    } else {
      if (capability.adapter) {
        violations.push(
          `"${capability.key}" is ${capability.state} but names adapter "${capability.adapter}"; ` +
            'a non-live capability must not reach the network',
        );
      }
      if (!capability.readiness) {
        violations.push(`"${capability.key}" is ${capability.state} with no readiness reason`);
      }
    }

    if (!capability.evidence.trim()) {
      violations.push(`"${capability.key}" states a status with no evidence`);
    }
  }

  if (violations.length > 0) throw new ManifestIntegrityError(violations);
}

assertManifestIntegrity();

const BY_KEY = new Map(CAPABILITIES.map((capability) => [capability.key, capability]));
const BY_HREF = new Map(CAPABILITIES.map((capability) => [capability.href, capability]));

export function capabilityByKey(key: string): Capability | undefined {
  return BY_KEY.get(key);
}

export function capabilityByHref(href: string): Capability | undefined {
  return BY_HREF.get(href);
}

/** Whether this capability may issue a network request. Only `LIVE` may. */
export function mayCallNetwork(capability: Capability): boolean {
  return capability.state === 'LIVE';
}
