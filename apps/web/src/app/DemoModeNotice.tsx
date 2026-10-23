import { Alert } from '@/ui';

/**
 * «حالت نمایشی» for a screen that shows or moves money (Q-14). Drawn by a
 * screen only when `fetchDemoMode` said the provider is simulated, so it never
 * claims more than the provider's own flag.
 */
export function DemoModeNotice() {
  return (
    <Alert tone="info" title="حالت نمایشی">
      پلتفرم به هیچ بانک یا درگاه واقعی متصل نیست و پولی جابه‌جا نمی‌شود.
    </Alert>
  );
}
