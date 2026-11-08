import type { JSX } from 'react';
import { Alert } from '@/ui';
import { RELEASE_MESSAGES, releaseFeedbackKey } from '@/lib/release-messages';

/** What a release redirect landed on the page to say; nothing when there was no release. */
export function ReleaseFeedback({ outcome }: { outcome?: string }): JSX.Element | null {
  return outcome === undefined ? null : (
    <Alert tone="warning">{RELEASE_MESSAGES[releaseFeedbackKey(outcome)]}</Alert>
  );
}
