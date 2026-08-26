# ADR-002: TypeScript + NestJS برای Backend

- **وضعیت:** Accepted
- **تاریخ:** 2026-08-26

## Context

۱۶ سرویس باید ساخته و به یک تیم انسانی تحویل شوند. یکنواختی ساختار میان سرویس‌ها اهمیت
بیشتری از بهینه بودن هر سرویس دارد. Frontend نیز TypeScript است؛ اشتراک نوع و Schema
میان لایه‌ها یک مزیت واقعی است، نه تزئینی.

## Decision

**Node.js 22 LTS + TypeScript 5.9 در حالت strict + NestJS 11** برای همه سرویس‌های Backend.

`strict: true` غیرقابل مذاکره است. `any` فقط با کامنت `JUSTIFIED-ANY` و دلیل مکتوب.

## Alternatives Considered

| گزینه | مزیت | عیب | چرا رد شد |
| --- | --- | --- | --- |
| Go | کارایی بالا، باینری کوچک، همزمانی عالی | زبان دوم در Stack؛ اشتراک نوع با Frontend از بین می‌رود | یکنواختی و سرعت تحویل مهم‌تر از کارایی خام در این مقیاس |
| Java + Spring Boot | بلوغ سازمانی، اکوسیستم قوی | مصرف حافظه بالا، زمان راه‌اندازی طولانی، زبان دوم | ۱۷ نمونه JVM روی زیرساخت محدود توجیه ندارد |
| Express یا Fastify خام | سبک، انعطاف بالا | هر سرویس ساختار خودش را می‌سازد | یکنواختی میان ۱۶ سرویس از بین می‌رود |
| Python + FastAPI | توسعه سریع | Type-Safety ضعیف‌تر، زبان دوم | یکپارچگی مالی نیازمند نوع‌های قوی است |

## Consequences

**مثبت**

- یک زبان در کل Stack؛ Schemaهای Zod میان Backend و Frontend مشترک‌اند
- ساختار ماژولار NestJS مرزهای درون‌سرویسی را تحمیل می‌کند
- Dependency Injection داخلی، تست‌پذیری را ساده می‌کند
- بار کاری I/O-bound با مدل رویدادی Node سازگار است

**منفی**

- کارایی CPU-bound پایین‌تر از Go یا Java
- NestJS نظرمند است؛ خروج از الگوهایش دشوار می‌شود
- دکوراتورها به `emitDecoratorMetadata` وابسته‌اند و ترجمه را کند می‌کنند (با @swc/jest جبران شده)
- مصرف حافظه Node بالاتر از Go

## Compliance

- `tsconfig.base.json` با `strict: true` برای همه Workspaceها
- قاعده ESLint `@typescript-eslint/no-explicit-any: error`
- `pnpm typecheck` در دروازه CI
