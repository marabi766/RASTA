import { Alert, ButtonLink, PageHeader } from '@/ui';

/**
 * What a signed-out visitor sees (docs/16 § 16.6, `/login`).
 *
 * Split from the route so it is a plain function of its props. The route reads
 * cookies and redirects — both of which need a request — and a component that
 * did either could only be tested by pretending to be a server. This one is
 * rendered in a test the same way a browser renders it.
 *
 * There is no form here, and that is the design rather than an omission: this
 * platform never handles anybody's password. The link hands the browser to
 * Keycloak, which is the only party that sees a credential, and the callback
 * returns a code the server exchanges (ADR-059).
 *
 * A link, not a scripted button. The page needs no JavaScript to work — which
 * is worth something on the connections docs/16 § 16.2 says this portal is for
 * — and a content security policy can forbid inline script without breaking
 * the way in.
 */

/** The refusals `auth/callback` can send back, in words a person can act on. */
export const LOGIN_REASONS: Record<string, string> = {
  provider_refused: 'ورود در سامانهٔ احراز هویت کامل نشد. اگر انصراف دادید، دوباره تلاش کنید.',
  no_attempt: 'این درخواست ورود دیگر معتبر نیست. از همین صفحه دوباره شروع کنید.',
  state_mismatch: 'پاسخ دریافتی با درخواست ورود شما نمی‌خواند. دوباره از همین صفحه شروع کنید.',
  id_token_rejected: 'پاسخ سامانهٔ احراز هویت تأیید نشد. اگر تکرار شد، با پشتیبانی تماس بگیرید.',
  token_request_failed: 'سامانهٔ احراز هویت در دسترس نبود. کمی بعد دوباره تلاش کنید.',
  malformed_response:
    'پاسخ سامانهٔ احراز هویت قابل خواندن نبود. اگر تکرار شد، با پشتیبانی تماس بگیرید.',
  login_failed: 'ورود کامل نشد. دوباره تلاش کنید.',
};

export function LoginScreen({ reason }: { reason?: string }) {
  // An unknown code renders nothing rather than being echoed back. Whatever
  // arrives in a query string is somebody else's text until this map has
  // agreed to it.
  const message = reason ? LOGIN_REASONS[reason] : undefined;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 p-6">
      <PageHeader title="ورود به رستا" description="برای ادامه با حساب سازمانی خود وارد شوید." />

      {message ? (
        <Alert tone="warning" title="ورود انجام نشد">
          {message}
        </Alert>
      ) : null}

      <ButtonLink href="/auth/login" className="py-3 text-base">
        ورود با حساب سازمانی
      </ButtonLink>

      <p className="text-sm text-content-muted">
        گذرواژهٔ شما هرگز به این پورتال وارد نمی‌شود؛ احراز هویت در سامانهٔ مرکزی سازمان انجام
        می‌گیرد.
      </p>
    </main>
  );
}
