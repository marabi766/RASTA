import { NextResponse } from 'next/server';

import { currentSession, sessionTemporarilyUnavailable } from '@/server/current-session';

/**
 * Whether this browser still has a session this server can open: `204` yes,
 * `401` no — it has ended — and `503` when it cannot be told right now. No
 * body, nothing about the session.
 *
 * Asked by a form whose server action call *threw* — Next rejects both a
 * dropped response and the request gate's `401` to an action POST the same way
 * (`request-gate.ts`), and the two mean different things to a person whose
 * command may have committed: "your session has ended, sign in" against "no
 * answer came back, the same request may be sent again" (PR 319 review 1,
 * finding 4). Only this authoritative `401` lets the form say the former.
 *
 * `401` is said only when the session has **ended**. A session middleware hid
 * because its access token ran out while the refresh was unavailable
 * (`session-state.ts`) may be renewed by the next request, so it is `503`:
 * unknown, and the form keeps its retry (PR 319 review 2, finding 3).
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const session = await currentSession();
  const status = session ? 204 : (await sessionTemporarilyUnavailable()) ? 503 : 401;
  const response = new NextResponse(null, { status });
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
