# ADR-008: Keycloak + OIDC/OAuth2 برای احراز هویت

- **وضعیت:** Accepted
- **تاریخ:** 2026-08-26

## Context

پلتفرم یازده نقش با محدوده‌های متفاوت دارد و کاربران می‌توانند در چند سازمان عضویت
هم‌زمان داشته باشند. الزامات:

- احراز هویت استاندارد برای Web، PWA و اپلیکیشن بومی آتی
- سیاست رمز عبور، محافظت در برابر Brute-Force، و **آمادگی MFA**
- امکان **Federation** برای اتصال احتمالی آتی به سامانه هویت ملی (Open Question Q-16)
- مرز روشن میان «هویت» و «عضویت سازمانی»

## Decision

**Keycloak 26** به‌عنوان Identity Provider، با **OIDC Authorization Code + PKCE**.

**تفکیک مسئولیت — مهم‌ترین بخش این تصمیم:**

| مالک | مسئولیت |
| --- | --- |
| Keycloak | احراز هویت، رمز عبور، Session، MFA، صدور توکن |
| `identity-service` | **عضویت سازمانی، نقش‌های دامنه‌ای، مجوزهای مؤثر** |

`identity-service` صفات `active_organization_id` و `organization_ids` را از راه Admin API
با Keycloak همگام می‌کند تا در توکن بنشینند.

سه Client: `rasta-web` (عمومی، PKCE) · `rasta-backend` (محرمانه، Service Account) ·
`rasta-api` (Bearer-Only، مقصد `aud`).

## Alternatives Considered

| گزینه | مزیت | عیب | چرا رد شد |
| --- | --- | --- | --- |
| احراز هویت دست‌ساز | کنترل کامل، بدون وابستگی | امنیت رمز عبور، MFA، Session و Federation باید از صفر ساخته شود | این دقیقاً جایی است که نباید چرخ را دوباره ساخت |
| Auth0 یا Okta | مدیریت‌شده، کم‌دردسر | وابستگی به سرویس بیرونی؛ ملاحظات میزبانی داده | داده هویت باید تحت کنترل باشد |
| Ory Kratos + Hydra | ماژولار، سبک | نیاز به چند جزء؛ Federation پیچیده‌تر | Keycloak همه را یکجا دارد |
| نگهداری همه نقش‌ها در Keycloak | یک منبع | عضویت سازمانی یک مفهوم دامنه‌ای است، نه هویتی | مدل سازمانی رستا پویاتر از آن است که در IdP بنشیند |

## Consequences

**مثبت**

- OIDC استاندارد؛ هر کلاینت آتی (Flutter، Native) بدون تغییر Backend کار می‌کند
- MFA با یک تغییر پیکربندی فعال می‌شود — بدون تغییر کد
- سیاست رمز عبور و محافظت Brute-Force آماده
- Federation برای اتصال آتی به هویت ملی ممکن است

**منفی**

- یک جزء زیرساختی سنگین (JVM) با پایگاه داده خودش
- همگام‌سازی صفات میان `identity-service` و Keycloak یک نقطه پیچیدگی است
- افت Keycloak، ورود جدید را می‌خواباند (توکن‌های صادرشده تا انقضا کار می‌کنند)
- در MVP با `start-dev` اجرا می‌شود که برای Production مناسب نیست

## Compliance

- Realm از `rasta-realm.json` وارد می‌شود — نه پیکربندی دستی
- عمر Access Token ۱۵ دقیقه؛ Refresh Token چرخشی با `refreshTokenMaxReuse=0`
- بررسی اجباری `iss`، `aud`، `exp` و امضا در Gateway
- توکن هرگز در `localStorage` — فقط حافظه و Cookie با `HttpOnly`
- **MFA اجباری برای نقش‌های حساس در Production** (Risks S-05)
