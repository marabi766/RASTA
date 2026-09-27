import { Alert } from '@/ui';
import { UNCONFIRMED_WRITE_MESSAGE } from '@/lib/unconfirmed-write';

/**
 * The one way every write form says "sent, not confirmed"
 * (`lib/unconfirmed-write.ts`). A warning, not a danger: nothing is known to
 * have failed.
 */
export function UnconfirmedWriteAlert({ correlationId }: { readonly correlationId: string }) {
  return (
    <Alert tone="warning">
      {UNCONFIRMED_WRITE_MESSAGE} کد پیگیری: {correlationId}
    </Alert>
  );
}
