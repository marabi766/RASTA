import { redirect } from 'next/navigation';
import { z } from 'zod';

import {
  CONFIRM_DUPLICATE_FIELD,
  CONFIRM_DUPLICATE_VALUE,
  RELEASE_FIELD,
} from '@/app/projects/form-state';
import {
  releaseFeedbackKey,
  type ReleaseFeedbackKey,
  type ReleaseSurface,
} from '@/lib/release-messages';
import { verifyCsrf } from './csrf';
import { pageHref } from './page-context';
import type { WebSession } from './session';
import { signPayload, verifyPayload } from './signed-payload';
import type { ReleaseOutcome } from './unresolved-request';

const PURPOSE = 'release-feedback';
const FLASH_TTL_SECONDS = 30;
const schema = z.object({
  surface: z.string(),
  target: z.string().nullable(),
  outcome: z.string(),
});

/**
 * Whose feedback a token is: the surface (a closed set, `lib/release-messages.ts`) and, where the
 * action is bound to a client-supplied id (the wallet, a supplier), that id. Surface and target are
 * separate signed fields, never one concatenated string, so no id — crafted or not — can spell
 * another surface's subject.
 */
export interface ReleaseSubject {
  readonly surface: ReleaseSurface;
  readonly target?: string;
}

/**
 * The signed `release` parameter a release redirect carries: the result, for this login and this subject.
 * Only the reader decides what a word means, so an answer it does not know cannot read as a success.
 */
export function releaseFeedback(
  session: WebSession,
  subject: ReleaseSubject,
  outcome: unknown,
): string {
  return signPayload(
    session,
    PURPOSE,
    { surface: subject.surface, target: subject.target ?? null, outcome: String(outcome) },
    FLASH_TTL_SECONDS,
  );
}

export function readReleaseFeedback(
  session: WebSession,
  subject: ReleaseSubject,
  token: unknown,
  idle: boolean,
): ReleaseFeedbackKey | undefined {
  const flash = verifyPayload(session, PURPOSE, token, schema);
  if (!flash || flash.surface !== subject.surface || flash.target !== (subject.target ?? null)) {
    return undefined;
  }
  const outcome = releaseFeedbackKey(flash.outcome);
  // A signed success can be replayed within its TTL. A newer hold or an unreadable store wins.
  if (!idle && (outcome === 'RELEASED' || outcome === 'GONE')) return undefined;
  return outcome;
}

/** The consent box a release form carries; the default is the duplicate-risk box, never "no box". */
export interface ReleaseConsent {
  readonly field: string;
  readonly value: string;
}
const DUPLICATE_RISK_CONSENT: ReleaseConsent = {
  field: CONFIRM_DUPLICATE_FIELD,
  value: CONFIRM_DUPLICATE_VALUE,
};

/**
 * The tail every held-request release action shares: CSRF, then the consent box, then the store, and
 * always a redirect that says what happened. `quietSuccess` keeps a plain redirect for RELEASED (the
 * form simply comes back); a refusal, and a GONE, never do.
 */
export async function settleRelease(options: {
  session: WebSession;
  form: FormData;
  /** The page the form lives on. */
  back: string;
  /** Whose feedback it is: namespaced, so no other surface reads the token. */
  subject: ReleaseSubject;
  release: (session: WebSession, token: unknown) => Promise<ReleaseOutcome>;
  quietSuccess?: boolean;
  consent?: ReleaseConsent;
}): Promise<never> {
  const {
    session,
    form,
    back,
    subject,
    release,
    quietSuccess = false,
    consent = DUPLICATE_RISK_CONSENT,
  } = options;
  const done = (outcome: unknown): never =>
    redirect(
      quietSuccess && outcome === 'RELEASED'
        ? pageHref(session, back)
        : pageHref(session, back, { release: releaseFeedback(session, subject, outcome) }),
    );
  if (!verifyCsrf(session, form).ok) return done('CSRF_REFUSED');
  if (form.get(consent.field) !== consent.value) return done('CONSENT_MISSING');
  return done(await release(session, form.get(RELEASE_FIELD)));
}
