import { redirect } from 'next/navigation';
import { z } from 'zod';

import {
  CONFIRM_DUPLICATE_FIELD,
  CONFIRM_DUPLICATE_VALUE,
  RELEASE_FIELD,
} from '@/app/projects/form-state';
import { releaseFeedbackKey, type ReleaseFeedbackKey } from '@/lib/release-messages';
import { verifyCsrf } from './csrf';
import { pageHref } from './page-context';
import type { WebSession } from './session';
import { signPayload, verifyPayload } from './signed-payload';
import type { ReleaseOutcome } from './unresolved-request';

const PURPOSE = 'release-feedback';
const FLASH_TTL_SECONDS = 30;
const schema = z.object({ subject: z.string(), outcome: z.string() });

/**
 * The signed `release` parameter a release redirect carries: the result, for this login and this subject.
 * Only the reader decides what a word means, so an answer it does not know cannot read as a success.
 */
export function releaseFeedback(session: WebSession, subject: string, outcome: unknown): string {
  return signPayload(session, PURPOSE, { subject, outcome: String(outcome) }, FLASH_TTL_SECONDS);
}

export function readReleaseFeedback(
  session: WebSession,
  subject: string,
  token: unknown,
  idle: boolean,
): ReleaseFeedbackKey | undefined {
  const flash = verifyPayload(session, PURPOSE, token, schema);
  if (!flash || flash.subject !== subject) return undefined;
  const outcome = releaseFeedbackKey(flash.outcome);
  // A signed success can be replayed within its TTL. A newer hold or an unreadable store wins.
  if (!idle && (outcome === 'RELEASED' || outcome === 'GONE')) return undefined;
  return outcome;
}

/**
 * The tail every snapshot-form release action shares: CSRF, then the consent box, then the store, and
 * always a redirect that says what happened. `quietSuccess` keeps a plain redirect for RELEASED (the
 * form simply comes back); a refusal never does.
 */
export async function settleRelease(options: {
  session: WebSession;
  form: FormData;
  /** The page the form lives on; also names whose feedback it is. */
  back: string;
  subject?: string;
  release: (session: WebSession, token: unknown) => Promise<ReleaseOutcome>;
  quietSuccess?: boolean;
}): Promise<never> {
  const { session, form, back, subject = back, release, quietSuccess = false } = options;
  const done = (outcome: unknown): never =>
    redirect(
      quietSuccess && outcome === 'RELEASED'
        ? pageHref(session, back)
        : pageHref(session, back, { release: releaseFeedback(session, subject, outcome) }),
    );
  if (!verifyCsrf(session, form).ok) return done('CSRF_REFUSED');
  if (form.get(CONFIRM_DUPLICATE_FIELD) !== CONFIRM_DUPLICATE_VALUE) return done('CONSENT_MISSING');
  return done(await release(session, form.get(RELEASE_FIELD)));
}
