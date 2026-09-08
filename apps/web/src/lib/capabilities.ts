import { REGISTERED_ADAPTERS, type AdapterId } from './api/adapter-registry';

/**
 * The single source of truth for what this application claims to do.
 *
 * Navigation, the dashboard, the guided walkthrough and the route guards all
 * read this file, so there is exactly one place where a capability's status can
 * be stated — and exactly one place to audit before a demo.
 *
 * ## Why the states are what they are
 *
 * The temptation in an investor build is a binary: things that work and things
 * that do not. That binary forces a lie in both directions. A service can be
 * implemented, tested and live-verified upstream while this application ships
 * no screen for it — calling that "planned" understates the platform, and
 * calling it "live" overstates the frontend. So the states describe *this*
 * application's relationship to a backend capability, not the backend alone.
 *
 * `LIVE` and `BETA` are the only states that make a claim about a network call,
 * and both carry a machine-checkable precondition: a registered adapter that
 * reaches a real gateway route (`assertManifestIntegrity`).
 */

export const CAPABILITY_STATES = [
  /** An implemented backend route, reached by a registered adapter in this app. */
  'LIVE',
  /**
   * Reached by a real adapter, but the domain phase behind it is unfinished.
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
   * carrying it says so, in the exact required wording.
   */
  'PREVIEW',
  /** No implementation anywhere. A gateway route, a topic or a design is not one. */
  'PLANNED',
] as const;

export type CapabilityState = (typeof CAPABILITY_STATES)[number];

/** The states permitted to issue a network request. */
const NETWORK_STATES: ReadonlySet<CapabilityState> = new Set<CapabilityState>(['LIVE', 'BETA']);

/** Why a capability is not fully `LIVE`. Shown verbatim on its screen. */
export type ReadinessReason =
  /** Backend contracts exist and are verified; the screen is the missing part. */
  | 'ARCHITECTURE_READY'
  /** Decided, not built. No service, no schema, no route handler. */
  | 'PLANNED'
  /** Waiting on a product or governance decision, not on engineering. */
  | 'BLOCKED_BY_PRODUCT_DECISION'
  /** Part of the domain shipped; the rest has not started. */
  | 'PARTIAL';

/** Which business area a capability belongs to, for the executive dashboard. */
export type DomainKey = 'fleet' | 'commerce' | 'finance' | 'civil' | 'platform';

export interface Capability {
  /** Stable key. Used by routes, tests, the walkthrough and the dashboard. */
  readonly key: string;
  /** The route this capability owns. Always a real, resolvable path. */
  readonly href: string;
  readonly title: string;
  readonly summary: string;
  readonly state: CapabilityState;
  /** Which backend service owns the data, or `null` where none exists yet. */
  readonly service: string | null;
  /** Required for `LIVE` and `BETA`, forbidden otherwise. */
  readonly adapter?: AdapterId;
  /** Forbidden for `LIVE`, required otherwise. */
  readonly readiness?: ReadinessReason;
  /**
   * Where the claim comes from. A status with no citation is an opinion, and
   * this is the field a reviewer checks first.
   */
  readonly evidence: string;
  readonly domain: DomainKey;
  /** Hidden from the navigation rail; still routable and still in the map. */
  readonly secondary?: boolean;
}

export interface Domain {
  readonly key: DomainKey;
  readonly title: string;
  /** What this area of the product is for, in one sentence. */
  readonly proposition: string;
}

/**
 * The five product areas.
 *
 * Ordered the way the platform is actually built up: an asset exists, it is
 * operated, it is maintained, it is bought for and paid for, and the whole
 * thing is governed. That is also the order the guided walkthrough follows.
 */
export const DOMAINS: readonly Domain[] = [
  {
    key: 'fleet',
    title: 'ناوگان و دارایی',
    proposition:
      'دارایی — نه کاربر — موجودیت مرکزی است. هر ماشین یک پروندهٔ الکترونیکی دارد که می‌گوید چیست، امروز قابل اعزام هست یا نه، چقدر هزینه برداشته و چه بر سرش آمده.',
  },
  {
    key: 'commerce',
    title: 'بازار و تأمین',
    proposition:
      'خرید مشترک کالا و خدمت از فهرست چندتأمین‌کننده، با چرخهٔ سفارشی که وجه را پیش از تحویل نگه می‌دارد و تنها با تأیید خریدار آزاد می‌کند.',
  },
  {
    key: 'finance',
    title: 'مالی و حسابداری',
    proposition:
      'دفتر کل دوطرفهٔ تغییرناپذیر به‌عنوان مرجع حقیقت مالی، و کیف پول به‌عنوان نمای عملیاتی آن. پرداخت در MVP شبیه‌سازی‌شده و پشت Abstraction است.',
  },
  {
    key: 'civil',
    title: 'عملیات عمرانی',
    proposition:
      'پروژه، نیاز، گردش موافقت، مناقصه و قرارداد. هنوز ساخته نشده؛ مرزهای آن در ADRها ثبت شده است.',
  },
  {
    key: 'platform',
    title: 'پلتفرم و حکمرانی',
    proposition:
      'هویت، سازمان چندسطحی، اسناد، حسابرسی و اعلان — لایه‌ای که چندمستأجری بودن و قابل‌ممیزی بودن بقیهٔ پلتفرم را ممکن می‌کند.',
  },
];

/**
 * The manifest.
 *
 * Status here follows `PROJECT_MEMORY.md` § 3 and § 7 — the repository's own
 * record of what is implemented, tested and live-verified — never a gateway
 * route, a Kafka topic, a service scaffold or an approved design, none of
 * which are implementations.
 */
export const CAPABILITIES: readonly Capability[] = [
  // ---- fleet ---------------------------------------------------------------
  {
    key: 'assets',
    href: '/assets',
    title: 'ماشین‌آلات و پروندهٔ الکترونیکی',
    summary:
      'فهرست و جست‌وجوی دارایی، و پروندهٔ الکترونیکی هر ماشین: هویت، انطباق، هزینهٔ انباشته و خط زمانی رویدادها.',
    state: 'LIVE',
    service: 'asset-service',
    adapter: 'asset.registry',
    evidence:
      'services/asset-service/src/asset/asset.controller.ts — GET /v1/assets، /{id}/dossier، /{id}/timeline',
    domain: 'fleet',
  },
  {
    key: 'fleet',
    href: '/fleet',
    title: 'ناوگان: آمادگی، راننده و کارکرد',
    summary:
      'اینکه کدام ماشین امروز قابل اعزام است و چرا نیست، به‌همراه راننده، تخصیص و رکورد کارکرد.',
    state: 'LIVE',
    service: 'fleet-service',
    adapter: 'fleet.operations',
    evidence:
      'services/fleet-service/src/fleet/*.controller.ts — GET /v1/fleet/availability، /utilization، /v1/drivers، /v1/assignments، /v1/usage-records',
    domain: 'fleet',
  },
  {
    key: 'maintenance',
    href: '/maintenance',
    title: 'نگهداری و تعمیرات',
    summary:
      'سررسید سرویس که در هر فراخوانی محاسبه می‌شود، درخواست‌های تعمیر و دستور کار تعمیرگاه با هزینهٔ تفکیک‌شده.',
    state: 'LIVE',
    service: 'maintenance-service',
    adapter: 'maintenance.operations',
    evidence:
      'services/maintenance-service/src/maintenance/*.controller.ts — GET /v1/maintenance-schedules/due، /v1/maintenance-requests، /v1/repair-orders',
    domain: 'fleet',
  },

  // ---- commerce ------------------------------------------------------------
  {
    key: 'marketplace',
    href: '/marketplace',
    title: 'بازار و مقایسه پیشنهادها',
    summary: 'جست‌وجوی فهرست کالا و خدمت، و مقایسهٔ پیشنهادهای منتشرشدهٔ تأمین‌کنندگان.',
    state: 'LIVE',
    service: 'marketplace-service',
    adapter: 'marketplace.catalogue',
    evidence:
      'services/marketplace-service/src/offer/catalogue.controller.ts — GET /v1/products، GET /v1/products/{id}/offers',
    domain: 'commerce',
  },
  {
    key: 'orders',
    href: '/orders',
    title: 'سفارش‌ها و چرخهٔ عمر',
    summary:
      'یازده وضعیت واقعی سفارش از ثبت تا تسویه، با ماشین حالتی که نبودِ دو یال در آن، کل مدل ایمنی مالی است.',
    state: 'LIVE',
    service: 'marketplace-service',
    adapter: 'marketplace.orders',
    evidence:
      'services/marketplace-service/src/order/order.controller.ts و order/state-machine.ts — GET /v1/orders، GET /v1/orders/{id}',
    domain: 'commerce',
  },
  {
    key: 'suppliers',
    href: '/suppliers',
    title: 'تأمین‌کنندگان',
    summary:
      'فهرست عمومی تأمین‌کنندگان با قابلیت‌های اعلامی و صلاحیت‌های تأییدشده. امتیاز عملکرد وجود ندارد.',
    state: 'BETA',
    service: 'supplier-service',
    adapter: 'supplier.directory',
    readiness: 'PARTIAL',
    evidence:
      'فاز ۱ روی main (36d718cf). Phase 2 شروع نشده و COM-005 هنوز IN_PROGRESS است — services/supplier-service/src/supplier/supplier.controller.ts، GET /v1/suppliers',
    domain: 'commerce',
  },

  // ---- finance -------------------------------------------------------------
  {
    key: 'wallet',
    href: '/wallet',
    title: 'کیف پول و تراکنش',
    summary: 'مانده، تعهد و مانده قابل استفاده، فهرست تراکنش‌ها، و افشای رسمی ارائه‌دهندهٔ پرداخت.',
    state: 'LIVE',
    service: 'economic-service',
    adapter: 'economic.wallet',
    evidence:
      'services/economic-service/src/wallet/wallet.controller.ts و transaction/transaction.controller.ts — GET /v1/wallets/me، /v1/wallets/provider، /v1/transactions',
    domain: 'finance',
  },
  {
    key: 'ledger',
    href: '/wallet/ledger',
    title: 'دفتر کل و تراز آزمایشی',
    summary:
      'حساب‌های سازمان و اثبات توازن دوطرفه. مقدار `balanced: false` یک هشدار بحرانی است، نه یک گزارش.',
    state: 'LIVE',
    service: 'economic-service',
    adapter: 'economic.ledger',
    evidence:
      'services/economic-service/src/ledger/ledger.controller.ts — GET /v1/ledger/accounts، GET /v1/ledger/trial-balance (فقط SYSTEM_ADMIN و UNION_ADMIN)',
    domain: 'finance',
  },
  {
    key: 'rewards',
    href: '/rewards',
    title: 'امتیاز مشارکت',
    summary:
      'موتور پاداش در Backend پیاده شده، اما نردبان سطح و ارزش‌گذاری ریالی هنوز تصمیم محصولی ندارند.',
    state: 'BACKEND_READY',
    service: 'economic-service',
    readiness: 'BLOCKED_BY_PRODUCT_DECISION',
    evidence:
      'GET /v1/rewards/me پیاده است، اما Q-09 (سهم کارمزد از پاداش) و Q-13 (نردبان سطح) باز‌اند و RewardBalanceView.level برابر null است.',
    domain: 'finance',
    secondary: true,
  },
  {
    key: 'commissions',
    href: '/commissions',
    title: 'کارمزد و قواعد آن',
    summary: 'محاسبهٔ کارمزد پیاده شده است، اما نرخ آن هنوز مصوب نشده (Q-08).',
    state: 'BACKEND_READY',
    service: 'economic-service',
    readiness: 'BLOCKED_BY_PRODUCT_DECISION',
    evidence:
      'GET /v1/commissions و /commissions/rules پیاده‌اند؛ createCommissionRuleSchema.rateBasisPoints بدون مقدار پیش‌فرض است و Q-08 در docs/24 باز است.',
    domain: 'finance',
    secondary: true,
  },

  // ---- platform ------------------------------------------------------------
  {
    key: 'profile',
    href: '/profile',
    title: 'حساب کاربری و عضویت‌ها',
    summary:
      'کاربر احراز هویت‌شده، عضویت‌های سازمانی او و نقش‌های مؤثر در سازمان فعال، از سرویس هویت.',
    state: 'LIVE',
    service: 'identity-service',
    adapter: 'identity.me',
    evidence: 'services/identity-service/src/identity/identity.controller.ts — GET /v1/users/me',
    domain: 'platform',
  },
  {
    key: 'organizations',
    href: '/organizations',
    title: 'سازمان و انتخاب مستأجر',
    summary: 'سازمان‌های قابل مشاهده، و تفاوت میان «دیدن» یک سازمان و «عمل کردن به‌نام» آن.',
    state: 'LIVE',
    service: 'organization-service',
    adapter: 'organization.directory',
    evidence:
      'services/organization-service/src/organization/organization.controller.ts — GET /v1/organizations',
    domain: 'platform',
  },
  {
    key: 'users',
    href: '/users',
    title: 'کاربران سازمان',
    summary: 'کاربران سازمان فعال و نقش‌هایشان. تنها برای مدیر سازمان و مدیر اتحادیه باز است.',
    state: 'LIVE',
    service: 'identity-service',
    adapter: 'identity.directory',
    evidence:
      'services/identity-service/src/identity/identity.controller.ts — GET /v1/users با نقش‌های ORGANIZATION_ADMIN و UNION_ADMIN',
    domain: 'platform',
  },
  {
    key: 'documents',
    href: '/documents',
    title: 'اسناد و وضعیت اسکن',
    summary:
      'فراداده اسناد و معنای دقیق هر وضعیت اسکن بدافزار. دانلود Fail-Closed است: تنها CLEAN تحویل داده می‌شود.',
    state: 'LIVE',
    service: 'document-service',
    adapter: 'document.registry',
    evidence:
      'services/document-service/src/document/document.controller.ts — GET /v1/documents (ADR-049، ADR-014)',
    domain: 'platform',
  },

  // ---- not built -----------------------------------------------------------
  {
    key: 'procurement',
    href: '/procurement',
    title: 'تأمین، تجمیع تقاضا و استعلام',
    summary: 'ثبت نیاز، تجمیع میان سازمان‌ها، استعلام بها و سفارش خرید.',
    state: 'PLANNED',
    service: null,
    readiness: 'PLANNED',
    evidence:
      'services/procurement-service وجود ندارد. مسیر `demand-requests` در جدول Gateway هست اما سرویسی پشت آن ساخته نشده.',
    domain: 'commerce',
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
      'ADR-041 § ۲ — رزرو موجودی وجود ندارد؛ availableQuantity روی هر پیشنهاد، اعلام تأمین‌کننده است نه موجودی انبار.',
    domain: 'commerce',
  },
  {
    key: 'returns',
    href: '/returns',
    title: 'مرجوعی و لجستیک معکوس',
    summary: 'مرجوعی، ضمانت و حمل برگشت.',
    state: 'PLANNED',
    service: null,
    readiness: 'BLOCKED_BY_PRODUCT_DECISION',
    evidence: 'ADR-048 مرز لجستیک معکوس را ثبت کرده، اما هیچ سرویسی آن را پیاده نکرده است.',
    domain: 'commerce',
  },
  {
    key: 'construction',
    href: '/projects',
    title: 'پروژه‌های عمرانی و مناقصه',
    summary: 'پروژه، نیاز، گردش موافقت، مناقصه، پیشنهاد و پیشرفت کار.',
    state: 'PLANNED',
    service: null,
    readiness: 'PLANNED',
    evidence: 'PROJECT_MEMORY.md § ۷ — construction-service: NOT_STARTED',
    domain: 'civil',
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
    domain: 'civil',
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
    domain: 'platform',
  },
  {
    key: 'audit',
    href: '/audit',
    title: 'سوابق حسابرسی',
    summary: 'رویداد حسابرسی، فقط الحاقی و غیرقابل تغییر.',
    state: 'PLANNED',
    service: null,
    readiness: 'PLANNED',
    evidence: 'در main فقط Bootstrap سرویس Merge شده (PR #38). AuditEvent پیاده نشده.',
    domain: 'platform',
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
    domain: 'platform',
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
  const hrefs = new Set<string>();

  for (const capability of capabilities) {
    if (seen.has(capability.key)) violations.push(`duplicate capability key "${capability.key}"`);
    seen.add(capability.key);

    if (hrefs.has(capability.href)) violations.push(`duplicate href "${capability.href}"`);
    hrefs.add(capability.href);

    if (!capability.href.startsWith('/')) {
      violations.push(`"${capability.key}" has a non-absolute href "${capability.href}"`);
    }

    if (NETWORK_STATES.has(capability.state)) {
      if (!capability.adapter) {
        violations.push(`"${capability.key}" is ${capability.state} with no adapter named`);
      } else if (!registered.has(capability.adapter)) {
        violations.push(
          `"${capability.key}" is ${capability.state} and names adapter ` +
            `"${capability.adapter}", which is not registered — nothing in this ` +
            'application calls it',
        );
      }
      if (!capability.service) {
        violations.push(`"${capability.key}" is ${capability.state} with no owning service`);
      }
    } else if (capability.adapter) {
      violations.push(
        `"${capability.key}" is ${capability.state} but names adapter "${capability.adapter}"; ` +
          'a capability in this state must not reach the network',
      );
    }

    if (capability.state === 'LIVE' && capability.readiness) {
      violations.push(`"${capability.key}" is LIVE and also carries a readiness reason`);
    }
    if (capability.state !== 'LIVE' && !capability.readiness) {
      violations.push(`"${capability.key}" is ${capability.state} with no readiness reason`);
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

/** Whether this capability may issue a network request. */
export function mayCallNetwork(capability: Capability): boolean {
  return NETWORK_STATES.has(capability.state);
}

export function capabilitiesInDomain(domain: DomainKey): Capability[] {
  return CAPABILITIES.filter((capability) => capability.domain === domain);
}

/** The exact disclosure any non-operational surface must carry. */
export const PREVIEW_DISCLOSURE = 'PREVIEW — داده نمایشی است و عملیات واقعی انجام نمی‌شود';
