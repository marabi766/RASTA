# ۱۶ — UI Architecture

> Next.js · React · TypeScript · Tailwind. **RTL و فارسی‌محور از پایه، نه به‌عنوان وصله.**
> هدف: Demo بسیار حرفه‌ای، بدون ایجاد بدهی UI که بعداً نیاز به بازنویسی گسترده داشته باشد.

---

## ۱۶٫۱ Stack

| لایه          | انتخاب                       | دلیل                                                  |
| ------------- | ---------------------------- | ----------------------------------------------------- |
| Framework     | Next.js 15 (App Router)      | SSR برای داشبورد سنگین، Streaming، Route Handler، PWA |
| UI            | React 19 + TypeScript strict | Server Component، مدل داده یکسان با Backend           |
| Styling       | Tailwind CSS v4              | **Logical Property بومی** → RTL بدون شاخه‌بندی کد     |
| Component     | Radix UI Primitives          | دسترس‌پذیر و بدون Style؛ ما ظاهر را کنترل می‌کنیم     |
| فرم           | React Hook Form + Zod        | **همان Schemaهای `@rasta/contracts`** — یک منبع حقیقت |
| داده سمت سرور | TanStack Query               | Cache، Retry، به‌روزرسانی خوش‌بینانه                  |
| نمودار        | Recharts                     | سبک، سازگار با SSR، قابل تم‌بندی                      |
| جدول          | TanStack Table               | مرتب‌سازی، فیلتر و صفحه‌بندی سمت سرور                 |
| آیکون         | Lucide React                 | ثابت، Tree-shakeable                                  |
| تقویم         | `date-fns-jalali`            | تبدیل هجری شمسی **فقط در لایه ارائه**                 |
| احراز هویت    | `oidc-client-ts`             | Authorization Code + PKCE                             |

**CONSTRAINT.** Zod Schema از `@rasta/contracts` می‌آید. یک تعریف: هم اعتبارسنجی فرم،
هم اعتبارسنجی سرور، هم نوع TypeScript، هم مستند OpenAPI. اگر فرم و API از هم واگرا شوند،
Build می‌شکند.

---

## ۱۶٫۲ دو اپلیکیشن

| اپ           | مخاطب                                                | پورت | تمرکز                                |
| ------------ | ---------------------------------------------------- | ---- | ------------------------------------ |
| `apps/web`   | کاربر نهایی — دهیاری، اپراتور، تأمین‌کننده، پیمانکار | 3200 | عملیات روزمره؛ **PWA و موبایل‌محور** |
| `apps/admin` | اپراتور پلتفرم (اتحادیه) + ناظر (استانداری)          | 3201 | مدیریت، پیکربندی، داشبورد تجمیعی     |

**چرا دو اپ و نه یک اپ با نقش‌های متفاوت؟**
مخاطبان، دستگاه‌ها و الگوهای استفاده به‌کلی متفاوت‌اند. یک اپراتور ماشین‌آلات در روستا با
موبایل و اینترنت ضعیف کار می‌کند و به سه صفحه نیاز دارد. یک کارشناس اتحادیه با دسکتاپ و
جدول‌های سنگین کار می‌کند. تحمیل یک Bundle به هر دو، تجربه هر دو را بد می‌کند.
Design System مشترک است؛ Bundle نیست.

---

## ۱۶٫۳ RTL و فارسی‌محوری

این بخش **الزام معماری** است، نه سلیقه.

```html
<html lang="fa" dir="rtl"></html>
```

| قاعده                                           | چرا                                            |
| ----------------------------------------------- | ---------------------------------------------- |
| **همیشه** Logical Property                      | `ms-4` نه `ml-4`؛ `text-start` نه `text-left`  |
| هرگز `left`/`right` فیزیکی در چیدمان            | در RTL معکوس نمی‌شوند                          |
| آیکون‌های جهت‌دار در RTL آینه می‌شوند           | فلش «بعدی» به چپ اشاره می‌کند                  |
| **اعداد در داده و API همیشه لاتین**             | تبدیل به فارسی فقط در لحظه رندر                |
| **تاریخ در پایگاه داده و API همیشه میلادی/UTC** | تبدیل به هجری شمسی فقط در لحظه رندر            |
| نیم‌فاصله (ZWNJ) در متن فارسی رابط              | «می‌شود» نه «می شود»                           |
| نویسه‌های استاندارد فارسی                       | «ی» و «ک» فارسی، نه عربی                       |
| جهت‌دهی صحیح متن دوزبانه                        | شناسه‌های لاتین داخل متن فارسی با `dir="auto"` |

**فونت:** Vazirmatn (متغیر) برای فارسی، `ui-monospace` برای شناسه و کد.
بارگذاری محلی با `next/font` — بدون CDN خارجی (کنترل CSP و کارایی).

**تست RTL اجباری.** هر Component در هر دو جهت Snapshot می‌شود. یک Component که فقط در
LTR درست است، در این پروژه شکسته است.

---

## ۱۶٫۴ Design System

### Design Token

```css
:root {
  /* ---- رنگ‌های برند ---- */
  --color-primary-50 … --color-primary-950;   /* سبز-فیروزه‌ای: هویت رستا */
  --color-neutral-50 … --color-neutral-950;

  /* ---- رنگ‌های معنایی ---- */
  --color-success: …;   /* فعال، تأییدشده، تحویل‌شده */
  --color-warning: …;   /* سررسید نزدیک، در انتظار تأیید */
  --color-danger:  …;   /* خرابی، رد شده، منقضی */
  --color-info:    …;   /* اطلاع‌رسانی */

  /* ---- سطح ---- */
  --surface-base / --surface-raised / --surface-overlay / --surface-sunken;

  /* ---- تایپوگرافی (مقیاس ۱٫۲۵) ---- */
  --text-xs: 0.75rem … --text-3xl: 2rem;
  --leading-tight / --leading-normal / --leading-relaxed;

  /* ---- فاصله (پایه ۴px) ---- */
  --space-1: 0.25rem … --space-16: 4rem;

  /* ---- شعاع، سایه، انیمیشن ---- */
  --radius-sm … --radius-full;
  --shadow-sm … --shadow-lg;
  --duration-fast: 150ms; --duration-normal: 250ms;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
}
```

**قاعده.** هیچ رنگ، فاصله یا اندازه‌ای در Component به‌صورت Hard-Code نوشته نمی‌شود.
همه از Token. این تفاوت میان «Design System» و «مجموعه‌ای از Componentها» است.

**Dark Mode.** Tokenها در `[data-theme="dark"]` بازتعریف می‌شوند. هیچ Component شاخه
روشن/تیره ندارد.

### کتابخانه Component

| دسته      | Componentها                                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| چیدمان    | `AppShell` · `Sidebar` · `TopBar` · `PageHeader` · `Section` · `Grid`                                                           |
| داده      | `DataTable` · `StatCard` · `MetricTile` · `Timeline` · `DescriptionList`                                                        |
| فرم       | `Form` · `TextField` · `NumberField` · `MoneyField` · `DateField` (شمسی) · `Select` · `Combobox` · `FileUpload` · `FormSection` |
| بازخورد   | `StatusBadge` · `Alert` · `Toast` · `ProgressBar` · `WorkflowStepper`                                                           |
| Overlay   | `Dialog` · `Drawer` · `Popover` · `Tooltip` · `ConfirmDialog`                                                                   |
| ناوبری    | `Tabs` · `Breadcrumb` · `Pagination` · `CommandPalette`                                                                         |
| نمودار    | `LineChart` · `BarChart` · `DonutChart` · `Sparkline` · `GaugeChart`                                                            |
| **وضعیت** | `EmptyState` · `LoadingState` · `ErrorState` · `Skeleton` · `NoAccessState`                                                     |

**CONSTRAINT — سه حالت اجباری.** هر نمای داده‌محور **باید** هر سه را داشته باشد:

```
EmptyState   — «هنوز ماشین‌آلاتی ثبت نشده» + دکمه اقدام
LoadingState — Skeleton هم‌شکل با محتوای نهایی، نه Spinner وسط صفحه
ErrorState   — پیام قابل فهم + دکمه تلاش دوباره + correlationId برای پشتیبانی
```

نمایی که فقط حالت موفق دارد، ناقص است و Merge نمی‌شود.

---

## ۱۶٫۵ الگوهای کلیدی

### StatusBadge — زبان بصری وضعیت

هر وضعیت در پلتفرم یک رنگ و یک نماد ثابت دارد، در همه صفحات:

| وضعیت                                                  | رنگ     |
| ------------------------------------------------------ | ------- |
| `ACTIVE` · `APPROVED` · `COMPLETED` · `SETTLED`        | success |
| `PENDING_APPROVAL` · `BID_OPEN` · `IN_PROGRESS`        | warning |
| `REJECTED` · `CANCELLED` · `FAILED` · `OUT_OF_SERVICE` | danger  |
| `DRAFT` · `IDLE`                                       | neutral |
| `IN_MAINTENANCE` · `EVALUATION`                        | info    |

### WorkflowStepper — گردش‌کار قابل مشاهده

مناقصه، سفارش و صورت‌وضعیت همگی State Machine دارند. کاربر باید **همیشه بداند کجاست و
مرحله بعد چیست**:

```
ثبت نیاز ✓ ── اسناد ✓ ── موافقت ✓ ── انتشار ● ── پیشنهاد ○ ── ارزیابی ○ ── قرارداد ○
                                       ↑ اینجا
```

با نمایش مسئول هر مرحله و مهلت آن. این مستقیماً الزام «شفافیت و ثبت کامل سوابق» سند محصول است.

### MoneyField و نمایش پول

```
ذخیره/API:  "10000000"  (رشته، ریال)
نمایش:      ۱۰٬۰۰۰٬۰۰۰ ریال   (رقم فارسی، جداکننده هزارگان)
ورودی:      کاربر «۱۰٬۰۰۰٬۰۰۰» یا «10000000» می‌نویسد → نرمال به bigint
```

هرگز `parseFloat`. هرگز اعشار شناور. تبدیل رقم فارسی/عربی به لاتین در نرمال‌سازی ورودی.

### DateField

نمایش و ورودی هجری شمسی؛ ذخیره و ارسال ISO-8601 UTC. تقویم با ناوبری فارسی و نام ماه‌های
شمسی. نمایش دوگانه در Tooltip برای رفع ابهام.

---

## ۱۶٫۶ صفحات

### apps/web — پورتال کاربر نهایی

| مسیر                       | صفحه                       | نقش‌ها                            | فاز   |
| -------------------------- | -------------------------- | --------------------------------- | ----- |
| `/login`                   | ورود (OIDC)                | همه                               | P0    |
| `/`                        | داشبورد                    | همه                               | P0    |
| `/organizations`           | سازمان و اعضا              | ORGANIZATION_ADMIN                | P0    |
| `/assets`                  | فهرست ماشین‌آلات           | FLEET_MANAGER، OPERATOR           | P0    |
| `/assets/[id]`             | **پرونده الکترونیکی**      | FLEET_MANAGER، OPERATOR           | P0    |
| `/assets/[id]/timeline`    | تاریخچه دارایی             | FLEET_MANAGER                     | P0    |
| `/drivers`                 | راننده و تخصیص             | FLEET_MANAGER                     | P0    |
| `/usage`                   | ثبت کارکرد                 | OPERATOR، DRIVER                  | P0    |
| `/maintenance`             | نگهداری و تعمیرات          | FLEET_MANAGER، OPERATOR           | P0    |
| `/maintenance/[id]`        | جزئیات درخواست تعمیر       | FLEET_MANAGER، WORKSHOP           | P0    |
| `/marketplace`             | جست‌وجوی کالا و خدمت       | PROCUREMENT_USER                  | P0    |
| `/marketplace/[productId]` | مقایسه پیشنهادها           | PROCUREMENT_USER                  | P0    |
| `/orders`                  | سفارش‌ها                   | PROCUREMENT_USER، SUPPLIER        | P0    |
| `/orders/[id]`             | جزئیات سفارش + Stepper     | PROCUREMENT_USER، SUPPLIER        | P0    |
| `/procurement/demands`     | ثبت نیاز و تجمیع           | PROCUREMENT_USER                  | P1    |
| `/procurement/rfqs`        | استعلام‌ها                 | PROCUREMENT_USER، SUPPLIER        | P1    |
| `/suppliers`               | تأمین‌کنندگان              | PROCUREMENT_USER                  | P1    |
| `/projects`                | پروژه‌های عمرانی           | ORGANIZATION_ADMIN                | P0    |
| `/projects/[id]`           | جزئیات + گردش موافقت       | ORGANIZATION_ADMIN                | P0    |
| `/tenders`                 | مناقصه‌ها                  | ORGANIZATION_ADMIN، CONTRACTOR    | P0    |
| `/tenders/[id]`            | جزئیات + ثبت پیشنهاد       | ORGANIZATION_ADMIN، CONTRACTOR    | P0    |
| `/contracts`               | قراردادها                  | ORGANIZATION_ADMIN، CONTRACTOR    | P0    |
| `/contracts/[id]`          | جزئیات + صورت‌وضعیت        | ORGANIZATION_ADMIN، CONTRACTOR    | P0    |
| `/wallet`                  | کیف پول و تراکنش           | ORGANIZATION_ADMIN                | P0    |
| `/rewards`                 | امتیاز و سطح               | همه                               | P1    |
| `/rewards/history`         | Breakdown و نسخه قواعد     | همه                               | P1    |
| `/rewards/ranking`         | جایگاه در گروه همتای مجاز  | همه                               | P2    |
| `/rewards/benefits`        | مزایای مصوب و انتخاب       | همه                               | P2    |
| `/rewards/appeals`         | اعتراض و پیگیری امتیاز     | همه                               | P2    |
| `/insurance`               | بیمه‌نامه، تمدید و استعلام | ORGANIZATION_ADMIN، FLEET_MANAGER | P1/P2 |
| `/insurance/claims`        | پرونده‌های خسارت           | ORGANIZATION_ADMIN، FLEET_MANAGER | P2    |
| `/returns`                 | مرجوعی، ضمانت و حمل برگشت  | PROCUREMENT_USER، SUPPLIER        | P2    |
| `/notifications`           | اعلان‌ها                   | همه                               | P0    |
| `/reports`                 | گزارش‌ها                   | ORGANIZATION_ADMIN                | P1    |

### apps/admin — کنسول اپراتور

| مسیر                        | صفحه                              | نقش‌ها       | فاز |
| --------------------------- | --------------------------------- | ------------ | --- |
| `/`                         | داشبورد عملیاتی پلتفرم            | UNION_ADMIN  | P0  |
| `/organizations`            | مدیریت سازمان‌ها و سلسله‌مراتب    | UNION_ADMIN  | P0  |
| `/users`                    | کاربران، نقش‌ها، عضویت            | UNION_ADMIN  | P0  |
| `/suppliers`                | احراز صلاحیت و تعلیق              | UNION_ADMIN  | P1  |
| `/catalog`                  | مدیریت فهرست کالا                 | UNION_ADMIN  | P1  |
| `/financial`                | تراکنش، تسویه، کارمزد             | UNION_ADMIN  | P0  |
| `/financial/ledger`         | دفتر کل و تراز آزمایشی            | UNION_ADMIN  | P1  |
| `/config/commission-rules`  | **قواعد کارمزد**                  | SYSTEM_ADMIN | P1  |
| `/config/reward-rules`      | **قواعد پاداش**                   | SYSTEM_ADMIN | P1  |
| `/config/commission-lines`  | **خطوط کسب‌وکار کارمزد**          | SYSTEM_ADMIN | P1  |
| `/config/reward-benefits`   | **مزایا، گروه همتا و قواعد رتبه** | SYSTEM_ADMIN | P2  |
| `/config/approval-policies` | **سیاست‌های موافقت**              | SYSTEM_ADMIN | P1  |
| `/audit`                    | سوابق حسابرسی                     | UNION_ADMIN  | P0  |
| `/governance`               | **داشبورد تجمیعی استانداری**      | AUDITOR      | P1  |

**CONSTRAINT.** نقش `AUDITOR` **فقط** به `/governance` دسترسی دارد. مسیرهای دیگر برای این
نقش وجود ندارند — نه پنهان، بلکه Route Guard آن‌ها را رد می‌کند و API هم مجوز نمی‌دهد.
این مستقیماً الزام سند محصول است: «بدون دسترسی به جزئیات تراکنش‌های فردی».

---

## ۱۶٫۷ داشبوردها

| داشبورد     | مخاطب              | محتوا                                                                              |
| ----------- | ------------------ | ---------------------------------------------------------------------------------- |
| کاربر نهایی | دهیاری             | آمادگی ناوگان · سرویس‌های پیش رو · سفارش‌های باز · موجودی کیف پول · پروژه‌های فعال |
| ناوگان      | FLEET_MANAGER      | ترکیب ناوگان · نرخ بهره‌برداری · **نسبت تعمیر پیشگیرانه/اضطراری** · انقضای بیمه    |
| مالی        | UNION_ADMIN        | حجم تراکنش · درآمد کارمزد · تسویه معلق · اعتراض‌های باز                            |
| عمران       | ORGANIZATION_ADMIN | پروژه‌های فعال · در انتظار موافقت · مناقصه باز · تعداد پیشنهاد · صورت‌وضعیت معلق   |
| **حاکمیتی** | AUDITOR            | **فقط تجمیعی:** ترکیب ناوگان استان · روند هزینه · **سه شاخص اقتصادی**              |

**CONSTRAINT — صداقت داده.** KPIهای وابسته به خط مبنا تا پر نشدن `baseline_metric`
با پیام صریح «نیازمند ایجاد خط مبنا» نمایش داده می‌شوند — **نه صفر، نه عدد ساختگی**.
یک داشبورد که عدد جعلی نشان می‌دهد، بدتر از داشبورد خالی است.

---

## ۱۶٫۸ Gamification در UI

**قید صریح سند محصول:** «از الگوهای کودکانه یا سرگرمی‌محور پرهیز کند» و «متناسب با یک
سند دولتی-تعاونی».

```
✅ نمایش امتیاز به‌صورت شاخص عددی حرفه‌ای
✅ سطح کاربر به‌صورت نشان متنی ساده
✅ نوار پیشرفت آرام تا سطح بعد
✅ تمرکز پیام بر «کامل بودن داده» و «به‌موقع بودن»
✅ نمایش علت هر تغییر، نسخه قاعده و مسیر اعتراض
✅ مقایسهٔ شخص با بازهٔ گروه همتای هم‌نقش، بدون افشای دادهٔ ریز دیگران
✅ تفکیک «امتیاز مشارکت» از «امتیاز قابل تبدیل به مزیت»

❌ Confetti، انیمیشن جشن، صدا
❌ نشان‌های کارتونی، شخصیت، آواتار بازی‌گونه
❌ جدول رده‌بندی عمومی میان دهیاری‌ها یا نقش‌های نابرابر
❌ اصطلاحات بازی («امتیاز بگیر!»، «رکورد بزن!»)
```

معیار موفقیت: **نرخ ثبت به‌موقع داده**، نه میزان تعامل ظاهری.

مزایا، هدف گروهی و مشاهدهٔ رتبه فقط پس از پیکربندی مصوب فعال می‌شوند. حالت خالی باید
بگوید «مزیتی برای این دوره تعریف نشده است»، نه اینکه وعدهٔ پاداشی خارج از قرارداد بدهد.

---

## ۱۶٫۹ دسترس‌پذیری (WCAG 2.1 AA)

| الزام                                                      |
| ---------------------------------------------------------- |
| کنتراست ≥ ۴٫۵:۱ برای متن، ≥ ۳:۱ برای عناصر رابط            |
| هر عملکرد با صفحه‌کلید در دسترس؛ ترتیب Tab منطقی           |
| حلقه Focus قابل مشاهده — هرگز `outline: none` بدون جایگزین |
| HTML معنایی؛ ARIA فقط جایی که HTML کافی نیست               |
| هر ورودی `<label>` مرتبط دارد                              |
| خطای فرم با `aria-live` اعلام می‌شود و به فیلد گره می‌خورد |
| هدف لمسی ≥ ۴۴×۴۴ پیکسل                                     |
| هرگز رنگ به‌تنهایی حامل معنا نیست — همیشه با متن یا نماد   |
| `prefers-reduced-motion` رعایت می‌شود                      |

تست: `axe-core` در تست Component، و بررسی دستی صفحه‌کلید برای هر جریان بحرانی.

---

## ۱۶٫۱۰ کارایی و PWA

| هدف                       | مقدار            |
| ------------------------- | ---------------- |
| First Contentful Paint    | < ۱٫۵ ثانیه (3G) |
| Largest Contentful Paint  | < ۲٫۵ ثانیه      |
| Interaction to Next Paint | < ۲۰۰ms          |
| Cumulative Layout Shift   | < ۰٫۱            |
| Bundle اولیه JS           | < ۲۰۰KB gzip     |

**راهبرد:** Server Component به‌صورت پیش‌فرض · تقسیم کد بر اساس مسیر ·
`next/image` با AVIF/WebP · فونت محلی با `font-display: swap` · صفحه‌بندی سمت سرور.

**PWA (الزام سند محصول: «نسخه سازگار با تلفن همراه یا اپلیکیشن تحت وب پیشرونده»):**

- Manifest + آیکون
- Service Worker: Cache پوسته اپ و داده مرجع
- **صف Offline برای ثبت کارکرد** — اپراتور میدانی ممکن است اینترنت نداشته باشد؛
  ثبت محلی می‌شود و با بازگشت اتصال همگام‌سازی می‌شود (با `Idempotency-Key` تا تکراری نشود)
- نشانگر صریح وضعیت آنلاین/آفلاین

**آمادگی موبایل بومی.** همه منطق در API است، نه در UI. یک کلاینت Flutter یا Native در آینده
همان APIها را مصرف می‌کند بدون هیچ تغییر Backend.

---

## ۱۶٫۱۱ امنیت سمت کلاینت

```
✅ Access Token فقط در حافظه (نه localStorage — بردار XSS)
✅ Refresh Token در Cookie با HttpOnly + Secure + SameSite=Strict
✅ CSP سخت‌گیرانه؛ بدون inline script
✅ همه ورودی‌ها با همان Zod Schema سرور اعتبارسنجی می‌شوند
✅ Route Guard بر اساس نقش  (به‌عنوان UX، نه امنیت)
✅ نمایش correlationId در ErrorState برای پشتیبانی

🚫 dangerouslySetInnerHTML
🚫 هیچ Secret در متغیرهای NEXT_PUBLIC_
🚫 اتکا به مخفی کردن UI به‌عنوان کنترل امنیتی — سرور همیشه دوباره بررسی می‌کند
```

**CONSTRAINT.** پنهان کردن یک دکمه در UI **کنترل امنیتی نیست**. هر بررسی مجوز در UI
صرفاً برای تجربه کاربری است؛ سرور همیشه مستقلاً مجوزدهی می‌کند.
