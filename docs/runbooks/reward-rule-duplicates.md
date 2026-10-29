# Runbook: یافتن قاعده‌های پاداش پولیِ تکراری (ممیزی economic، F1)

**شدت:** ⚪ عملیاتی
**هشدار محرک:** ندارد — یک بار پس از استقرار economic-service با این تغییر، و هر بار که مدیری بگوید ایجاد قاعدهٔ پاداش
`500` داد و دوباره فرستاد.
**دامنه:** فقط خواندن. این Runbook هیچ قاعده‌ای را غیرفعال نمی‌کند و هیچ پاداشی را پس نمی‌گیرد.

---

## چرا ممکن است قاعدهٔ تکراری وجود داشته باشد

پیش از این تغییر، `POST /v1/rewards/rules` با `creditPerPointMinor` قاعده را **Commit می‌کرد و سپس `500` می‌داد**: پاسخ
ردیف Prisma بود با `bigint` خام، و در Production چیزی آن را به JSON تبدیل نمی‌کرد. مسیر Idempotency هم نداشت، پس مدیری
که دوباره فرستاد قاعدهٔ پولی دومی ساخت؛ و `grantFor` برای یک رویداد از **هر** قاعدهٔ فعال جداگانه پاداش می‌دهد، پس یک
رویداد دو بار به کیف پول پول واریز می‌کرد. اکنون پاسخ رشته است و `Idempotency-Key` اجباری است، اما قاعده‌هایی که پیش‌تر
ساخته شده‌اند سر جایشان‌اند.

## پرس‌وجو ۱ — نامزدها

دو قاعدهٔ `ACTIVE` و پولی با همان `trigger_event`، دامنه‌ای که به هم می‌رسد (همان سازمان، یا یکی سراسری) و بازهٔ اعتبار
هم‌پوشان. این فهرست **نامزد** است، نه حکم: دو کمپین هم‌شکل می‌توانند عمدی باشند، و شرط (`condition`) متفاوت یعنی دو
رویداد متفاوت را پاداش می‌دهند. قوی‌ترین نشانهٔ تکرارِ ناشی از خطا: همان `created_by`، شرط یکسان و فاصلهٔ چند ثانیه
(`seconds_apart`).

```sql
SELECT a.id AS earlier_rule, b.id AS later_rule, a.trigger_event,
       COALESCE(a.organization_id, '(platform-wide)') AS earlier_scope,
       COALESCE(b.organization_id, '(platform-wide)') AS later_scope,
       a.points || ' × ' || a.credit_per_point_minor AS earlier_terms,
       b.points || ' × ' || b.credit_per_point_minor AS later_terms,
       a.condition AS earlier_condition, b.condition AS later_condition,
       a.condition IS NOT DISTINCT FROM b.condition AS same_condition,
       a.valid_from AS earlier_from, a.valid_to AS earlier_to,
       b.valid_from AS later_from, b.valid_to AS later_to,
       a.created_by, b.created_by AS later_created_by,
       EXTRACT(EPOCH FROM b.created_at - a.created_at)::int AS seconds_apart
FROM reward_rule a
JOIN reward_rule b
  ON b.trigger_event = a.trigger_event
 AND (b.created_at, b.id) > (a.created_at, a.id)
 AND (a.organization_id IS NULL OR b.organization_id IS NULL
      OR a.organization_id = b.organization_id)
 AND tsrange(a.valid_from, a.valid_to, '[)') && tsrange(b.valid_from, b.valid_to, '[)')
WHERE a.status = 'ACTIVE' AND b.status = 'ACTIVE'
  AND a.credit_per_point_minor IS NOT NULL
  AND b.credit_per_point_minor IS NOT NULL
ORDER BY seconds_apart, a.trigger_event;
```

## پرس‌وجو ۲ — رویدادهایی که بیش از یک قاعده برایشان پول داده است

```sql
SELECT r.organization_id, r.user_id, r.trigger_event, r.source_reference,
       COUNT(*) AS grants,
       array_agg(r.rule_id ORDER BY r.granted_at) AS rules,
       SUM(r.credit_amount_minor)::text AS credited_minor
FROM reward r
WHERE r.monetised
GROUP BY r.organization_id, r.user_id, r.trigger_event, r.source_reference
HAVING COUNT(*) > 1
ORDER BY MIN(r.granted_at);
```

خروجی هر دو پرس‌وجو مبلغ و شناسهٔ سازمان دارد: در Ticket با دسترسی محدود نگه دارید، نه در Log یا گفت‌وگوی عمومی
(AGENTS.md S-09).

## پس از یافتن

- **غیرفعال‌کردن خودکار ندارد.** تصمیم با مالک محصول و مالی است. پایان‌دادن به قاعده‌ای که تکراری بودنش تأیید شد
  `PATCH /v1/rewards/rules/{id}` با `validTo` است (فقط رو به جلو). توجه: غیرفعال‌کردن امروز پاداش رویدادهای دیرتحویل‌شده
  یا بازپخش‌شده را هم حذف می‌کند (ممیزی economic، F7؛ وظیفهٔ ۱۱۶) — پیش از آن در صف‌های پاداش رویداد معوقی نباشد.
- **پس‌گرفتن پاداش ندارد.** عملیاتی برای Clawback پاداش تعریف نشده است (`REWARD_GRANT` در `journal-reversal.service.ts`،
  docs/24 Q-76)؛ Reversal دستی Journal پاداش رد می‌شود. مبلغ پرس‌وجو ۲ را برای تصمیم مالی گزارش کنید.

## منابع

- `services/economic-service/src/reward/reward.controller.ts` (`POST /v1/rewards/rules`، `Idempotency-Key`).
- `services/economic-service/src/shared/views.ts` (`toRewardRuleView`).
- `services/economic-service/test/wire-serialisation.int-spec.ts`.
