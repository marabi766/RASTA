# ADR-003: Next.js + React + Tailwind برای Frontend

- **وضعیت:** Accepted
- **تاریخ:** 2026-08-26

## Context

دو اپلیکیشن لازم است: پورتال کاربر نهایی (موبایل‌محور، PWA، برای اپراتور میدانی با اینترنت
ضعیف) و کنسول اپراتور پلتفرم (دسکتاپ، جدول‌های سنگین، داشبورد).

الزام محصول: **RTL و فارسی‌محور**، Responsive، Accessible، حرفه‌ای — و «بدون ایجاد بدهی UI
که بعداً نیاز به بازنویسی گسترده داشته باشد».

## Decision

**Next.js 15 (App Router) + React 19 + TypeScript strict + Tailwind CSS v4 + Radix UI**.

دو اپ مجزا (`apps/web`, `apps/admin`) با Design System مشترک اما Bundle جدا.
اعتبارسنجی فرم با همان Zod Schemaهای `@rasta/contracts`.

## Alternatives Considered

| گزینه                   | مزیت                            | عیب                                                     | چرا رد شد                                                      |
| ----------------------- | ------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------- |
| یک اپ با نقش‌های متفاوت | کد کمتر                         | Bundle سنگین برای اپراتور میدانی؛ تجربه هر دو بد می‌شود | مخاطب، دستگاه و الگوی استفاده کاملاً متفاوت است                |
| React SPA خام (Vite)    | ساده‌تر، کنترل کامل             | بدون SSR؛ داشبورد سنگین کند بارگذاری می‌شود             | SSR برای داشبورد و برای مناقصات منتشرشده عمومی ارزشمند است     |
| Angular                 | ساختار سازمانی، DI مشابه NestJS | اکوسیستم RTL ضعیف‌تر؛ Bundle بزرگ‌تر                    | Tailwind و Radix تجربه RTL بهتری می‌دهند                       |
| CSS-in-JS               | همجواری Style و Component       | Runtime Overhead؛ سازگاری ضعیف با Server Component      | Tailwind v4 با Logical Property، پشتیبانی RTL را رایگان می‌دهد |

## Consequences

**مثبت**

- Logical Property بومی Tailwind v4 پشتیبانی RTL را بدون شاخه‌بندی کد می‌دهد
- Server Component، Bundle اولیه را کوچک نگه می‌دارد
- Radix UI دسترس‌پذیری (WCAG) را از پایه می‌دهد
- یک Zod Schema برای فرم، API و OpenAPI

**منفی**

- App Router هنوز در حال تکامل است؛ الگوها ممکن است تغییر کنند
- Server Component مدل ذهنی جدیدی می‌خواهد
- دو اپ یعنی برخی Componentها باید مشترک شوند، با ریسک جفت‌شدگی
- Tailwind v4 نسبتاً جدید است

## Compliance

- تست Snapshot در هر دو جهت (RTL و LTR) برای هر Component
- تست `axe-core` برای دسترس‌پذیری
- قاعده Lint: منع کلاس‌های فیزیکی چپ و راست به نفع Logical Property
- بودجه کارایی در CI: Bundle اولیه کمتر از ۲۰۰ کیلوبایت gzip
