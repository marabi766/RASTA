'use server';

import { redirect } from 'next/navigation';

import { currentSession } from '@/server/current-session';
import { DEMAND_SUBMIT_RELEASE } from '@/server/demand-replay';
import { settleRelease } from '@/server/release-feedback';

import { type DemandFormState } from './demand-form-state';
import { runSubmitDemand } from './demand-runner';

/**
 * The demand form's server actions. The organization the demand is for is the
 * session's, never a field; whether the person may submit is procurement-service's
 * decision, and its refusal is said in fixed words (`demand-runner.ts`).
 */

export async function submitDemandRequest(
  _previous: DemandFormState,
  form: FormData,
): Promise<DemandFormState> {
  return runSubmitDemand(form);
}

/**
 * "Send as new": lets go of the unresolved submission so the next form carries a
 * fresh key — only with the confirmation that names the risk (the person checked
 * the **full** demand list and accepts that a second demand may result), and
 * only if the record is still the one the form was drawn for (a signed token,
 * compared and deleted in one step). Sends nothing to the service.
 */
export async function releaseUnresolvedDemand(form: FormData): Promise<void> {
  const back = '/procurement/demands';
  const session = await currentSession();
  if (!session) redirect(`/login?returnTo=${encodeURIComponent(back)}`);
  return settleRelease({
    session,
    form,
    back,
    subject: { surface: 'demand-submission' },
    scope: DEMAND_SUBMIT_RELEASE,
    quietSuccess: true,
  });
}
