import { Alert, EmptyState } from '@/ui';
import type { DemoMode } from '@/lib/demo-mode';

/**
 * What a screen that shows or moves money says about the payment provider
 * (Q-14), from `fetchDemoMode`: «حالت نمایشی» while it is simulated, nothing
 * once it is real, and — when it could not be read — that it is not known,
 * never silence: an unlabelled amount reads as real money.
 */
export function DemoModeNotice({ mode }: { readonly mode: DemoMode }) {
  if (mode === 'SIMULATED') {
    return (
      <Alert tone="info" title="حالت نمایشی">
        پلتفرم به هیچ بانک یا درگاه واقعی متصل نیست و پولی جابه‌جا نمی‌شود.
      </Alert>
    );
  }
  if (mode === 'UNKNOWN') {
    return (
      <Alert tone="warning" title="وضعیت درگاه پرداخت معلوم نیست">
        خوانده نشد که پرداخت‌ها شبیه‌سازی‌شده‌اند یا واقعی. تا روشن شدن آن، کارهایی که پول جابه‌جا
        می‌کنند در این صفحه در دسترس نیستند.
      </Alert>
    );
  }
  return null;
}

/**
 * In place of an action that moves money while the provider is `UNKNOWN`
 * (`mayOffer`): the wallet's own "withheld" state for its top-up form, so
 * every screen withholds the same way.
 */
export function MoneyActionWithheld({ title }: { readonly title: string }) {
  return (
    <EmptyState title={title} description="اطلاعات روش پرداخت خوانده نشد. بعداً دوباره سر بزنید." />
  );
}
