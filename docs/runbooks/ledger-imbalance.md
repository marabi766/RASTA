# Runbook: Journal نامتوازن یا انحراف کیف پول

**شدت:** 🔴 بحرانی
**هشدار محرک:** `LedgerBalanceAuditWorkflow` انحراف یافت · تلاش UPDATE روی `ledger_entry`
**زمان پاسخ هدف:** ۱۵ دقیقه

---

## علائم

یکی از این‌ها:

- حسابرسی روزانه یک یا چند `journal_id` نامتوازن گزارش کرد
- `wallet.ledgerBalance` با مجموع `ledger_entry` نمی‌خواند
- Trigger `trg_ledger_entry_immutable` شلیک شد (تلاش برای تغییر ورودی Post‌شده)
- تست یکپارچگی مالی در CI شکست خورد

## اثر

**یکپارچگی مالی نقض شده است.** موجودی نمایش‌داده‌شده به کاربران ممکن است نادرست باشد،
و گزارش درآمد کارمزد قابل استناد نیست.

---

## ⛔ اقدام فوری — پیش از هر تشخیص

**پردازش تسویه را متوقف کن.** ادامه دادن، انحراف را عمیق‌تر می‌کند.

```bash
# توقف Workerهای صف تسویه (بقیه سیستم کار می‌کند)
kubectl scale deployment temporal-worker-settlement --replicas=0 -n rasta-prod
```

در محیط محلی: فرایند Worker مربوطه را متوقف کن.

**هرگز** پایگاه داده را دستی اصلاح نکن. **هرگز** `ledger_entry` را UPDATE یا DELETE نکن.

---

## تشخیص

### ۱. کدام Journalها نامتوازن‌اند؟

```sql
SELECT journal_id, currency,
       SUM(CASE WHEN direction='DEBIT'  THEN amount_minor ELSE 0 END) AS total_debit,
       SUM(CASE WHEN direction='CREDIT' THEN amount_minor ELSE 0 END) AS total_credit,
       SUM(CASE WHEN direction='DEBIT'  THEN amount_minor ELSE -amount_minor END) AS delta
FROM ledger_entry
GROUP BY journal_id, currency
HAVING SUM(CASE WHEN direction='DEBIT' THEN amount_minor ELSE -amount_minor END) <> 0
ORDER BY journal_id;
```

### ۲. آن Journalها از کجا آمده‌اند؟

```sql
SELECT j.id, j.journal_type, j.transaction_id, j.posted_at, j.correlation_id, j.description
FROM journal j
WHERE j.id = ANY($1);
```

`correlation_id` را بردار — با آن کل مسیر درخواست در Log و Trace پیدا می‌شود.

### ۳. کدام کیف پول‌ها منحرف‌اند؟

```sql
SELECT w.id, w.organization_id, w.ledger_balance_minor,
       COALESCE(SUM(CASE WHEN le.direction='CREDIT' THEN le.amount_minor
                         ELSE -le.amount_minor END), 0) AS computed_balance
FROM wallet w
LEFT JOIN ledger_account a ON a.id = w.ledger_account_id
LEFT JOIN ledger_entry   le ON le.account_id = a.id
GROUP BY w.id, w.organization_id, w.ledger_balance_minor
HAVING w.ledger_balance_minor <> COALESCE(SUM(CASE WHEN le.direction='CREDIT'
       THEN le.amount_minor ELSE -le.amount_minor END), 0);
```

### ۴. وسعت را اندازه بگیر

```sql
SELECT MIN(posted_at) AS first_bad, MAX(posted_at) AS last_bad, COUNT(DISTINCT journal_id)
FROM ledger_entry WHERE journal_id = ANY($1);
```

اگر بازه زمانی طولانی است، یک باگ منطقی است، نه یک حادثه تکی.

---

## اقدام

### حالت A — یک Journal تکی نامتوازن است

احتمالاً Crash در میانه Post کردن. مسیر اصلاح:

```
۱. با correlationId، Trace کامل را بررسی کن و بفهم چه چیزی ناقص مانده
۲. یک Reversal Journal برای Journal ناقص از راه API ثبت کن:
      POST /v1/ledger/journals/{id}/reverse
      Idempotency-Key: <ULID جدید>
      { "reason": "Incident <شماره>: partial post recovery" }
۳. تراکنش کسب‌وکاری را از ابتدا با Idempotency-Key جدید اجرا کن
```

### حالت B — چند Journal از یک نوع نامتوازن‌اند

**این یک باگ در منطق مالی است، نه یک حادثه.**

```
۱. تسویه را متوقف نگه دار
۲. نوع Journal مشترک را شناسایی کن (journal_type)
۳. کد سازنده آن Journal را بررسی کن
۴. تست بازتولیدکننده بنویس  ← پیش از هر اصلاح داده
۵. باگ را رفع کن و مستقر کن
۶. سپس Reversal + بازاجرا برای همه Journalهای آسیب‌دیده
```

### حالت C — Trigger تغییرناپذیری شلیک شد

یک کد یا اسکریپت تلاش کرده ورودی Post‌شده را تغییر دهد.

```
۱. در Log دنبال متن "append-only" بگرد و منبع را پیدا کن
۲. اگر از کد اپلیکیشن است: یک باگ جدی است — رفعش کن
۳. اگر از یک اسکریپت دستی است: بررسی امنیتی لازم است
۴. Trigger کار خودش را کرد — داده سالم است
```

---

## تأیید رفع

```sql
-- باید صفر ردیف برگرداند
SELECT journal_id FROM ledger_entry
GROUP BY journal_id, currency
HAVING SUM(CASE WHEN direction='DEBIT' THEN amount_minor ELSE -amount_minor END) <> 0;
```

سپس:

```bash
pnpm --filter @rasta/economic-service test -- --testPathPattern=financial-integrity
kubectl scale deployment temporal-worker-settlement --replicas=2 -n rasta-prod
```

Workflow حسابرسی را دستی یک بار اجرا کن و منتظر نتیجه سبز بمان.

---

## پیشگیری

- بررسی توازن در **همان تراکنش** Post، پیش از Commit — نه فقط در حسابرسی روزانه
- تست همزمانی برای هر مسیر جدید Post کردن Journal
- هر Journal جدید نیازمند تست توازن اختصاصی است
- بازبینی اجباری برای هر تغییر در ماژول `ledger`

---

## پس از حادثه

- علت ریشه‌ای را در `docs/23-risks-and-tradeoffs.md` ثبت کن
- اگر ساده‌سازی MVP مقصر بود، به‌عنوان بدهی `D-0XX` ثبتش کن
- تست بازتولیدکننده را دائمی نگه دار
