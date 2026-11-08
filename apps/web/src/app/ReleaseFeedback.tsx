import type { JSX } from 'react';
import { Alert } from '@/ui';
import { releaseMessage, type ReleaseSurface } from '@/lib/release-messages';

/** What a release redirect landed on the page to say; nothing when there was no release. */
export function ReleaseFeedback({
  surface,
  outcome,
}: {
  surface: ReleaseSurface;
  outcome?: string;
}): JSX.Element | null {
  return outcome === undefined ? null : (
    <Alert tone="warning">{releaseMessage(outcome, surface)}</Alert>
  );
}
