/**
 * The guided walkthrough's script.
 *
 * A plain module, not a client component, and that separation is load-bearing:
 * a server component may import a *value* from here, but the same value
 * exported from a `'use client'` module arrives as a client-reference proxy and
 * reads as `undefined` on the server. The build caught exactly that — the
 * presentation page tried to render the total duration and got `undefined`.
 *
 * Each step carries the two sentences a presenter actually needs: what to show,
 * and the point of showing it.
 */

export interface WalkthroughStep {
  readonly id: string;
  readonly title: string;
  /** What the presenter should do on screen. */
  readonly action: string;
  /** Why it matters — the sentence that survives the room. */
  readonly point: string;
  /** Minutes to budget. The total is shown so a 15-minute slot can be planned. */
  readonly minutes: number;
  /** Which capability this step lands on, if any. */
  readonly capabilityKey?: string;
  readonly href?: string;
}

export const WALKTHROUGH: readonly WalkthroughStep[] = [
  {
    id: 'intro',
    title: 'مسئله و شکل راه‌حل',
    action: 'از داشبورد شروع کنید و پنج حوزهٔ محصول را نشان دهید.',
    point:
      'رستا دارایی‌محور است، نه کاربرمحور. ماشین‌آلات موجودیت مرکزی‌اند و بقیهٔ دامنه‌ها — راننده، تعمیر، خرید، پول — به همان دارایی گره می‌خورند. همین صفحه هم می‌گوید چه چیزی ساخته شده و چه چیزی نه.',
    minutes: 2,
    href: '/',
  },
  {
    id: 'identity',
    title: 'هویت واقعی و مستأجر',
    action: 'وارد شوید، سپس حساب کاربری و عضویت‌ها را باز کنید و سازمان فعال را عوض کنید.',
    point:
      'ورود از راه Keycloak با Authorization Code + PKCE انجام می‌شود؛ رمز عبور هرگز وارد این برنامه نمی‌شود. سازمان فعال، از ادعای امضاشدهٔ توکن می‌آید و درگاه API هر درخواست را در برابر همان اعتبارسنجی می‌کند.',
    minutes: 2,
    capabilityKey: 'profile',
  },
  {
    id: 'asset',
    title: 'پروندهٔ الکترونیکی دارایی',
    action: 'یک ماشین را از فهرست باز کنید و پروندهٔ آن را نشان دهید.',
    point:
      'این صفحه از داده‌ای ساخته شده که چهار سرویس مختلف مالک آن‌اند و از راه رویداد به هم رسیده‌اند. «قابل اعزام است یا نه» یک محاسبهٔ زنده است و هر مانع، سرویسِ مالکِ آن واقعیت را نام می‌برد.',
    minutes: 3,
    capabilityKey: 'assets',
  },
  {
    id: 'maintenance',
    title: 'سررسید نگهداری، محاسبه‌شده نه ذخیره‌شده',
    action: 'فهرست سررسیدها را باز کنید و به محرک هر سررسید اشاره کنید.',
    point:
      'سررسید در هر فراخوانی از کنتور واقعی ماشین و ساعت محاسبه می‌شود، نه از یک Flag ذخیره‌شده. یعنی یک اسکن پس‌زمینه که اجرا نشده، نمی‌تواند ماشینِ گذشته‌از‌موعد را سالم نشان دهد.',
    minutes: 2,
    capabilityKey: 'maintenance',
  },
  {
    id: 'marketplace',
    title: 'بازار و مقایسهٔ پیشنهادها',
    action: 'در بازار جست‌وجو کنید و پیشنهادهای یک کالا را باز کنید.',
    point:
      'ستون صلاحیت تأمین‌کننده عمداً «بررسی نشده» است، نه «رد شده» — چون سنجش عملکرد هنوز پیاده نشده و نمایش حکمی که کسی صادر نکرده، دروغ است. مرتب‌سازی بر اساس امتیاز هم وجود ندارد.',
    minutes: 2,
    capabilityKey: 'marketplace',
  },
  {
    id: 'orders',
    title: 'چرخهٔ سفارش و مدل ایمنی مالی',
    action: 'فهرست سفارش‌ها را باز کنید و ماشین حالت را نشان دهید.',
    point:
      'دو یالِ نبوده، کل مدل ایمنی است: از «در اعتراض» هیچ مسیری به «در حال تسویه» نیست، و وضعیت‌های پایانی هیچ یال خروجی ندارند. یعنی توقف تسویه هنگام اعتراض، یک قاعدهٔ فراموش‌شدنی نیست؛ در ساختار وجود ندارد.',
    minutes: 2,
    capabilityKey: 'orders',
  },
  {
    id: 'wallet',
    title: 'کیف پول، دفتر کل و افشای پرداخت',
    action: 'کیف پول را باز کنید، سپس تراز آزمایشی و افشای ارائه‌دهندهٔ پرداخت را نشان دهید.',
    point:
      'کیف پول نمای عملیاتی است و دفتر کل مرجع حقیقت. توازن، اثبات است نه گزارش. و افشای «پرداخت شبیه‌سازی‌شده» از خودِ API خوانده می‌شود، نه از یک متن ثابت — چون متن ثابت، روزی که ارائه‌دهندهٔ واقعی وصل شود، تبدیل به دروغ می‌شود.',
    minutes: 2,
    capabilityKey: 'wallet',
  },
  {
    id: 'honesty',
    title: 'آنچه ساخته نشده، و چرا این مهم است',
    action: 'یکی از کارت‌های «ساخته‌نشده» را باز کنید.',
    point:
      'هر بخش ساخته‌نشده، مسیر واقعی و صفحهٔ صریح خودش را دارد: می‌گوید در چه وضعیتی است، چرا، و اینکه هیچ عملیات واقعی انجام نمی‌شود. هیچ فرم قلابی، هیچ نمودار ساختگی و هیچ عدد اختراعی در این نسخه وجود ندارد.',
    minutes: 2,
    capabilityKey: 'procurement',
  },
];

export const WALKTHROUGH_MINUTES = WALKTHROUGH.reduce((total, step) => total + step.minutes, 0);
