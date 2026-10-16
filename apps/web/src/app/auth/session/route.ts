import { NextResponse } from 'next/server';

import { currentSession } from '@/server/current-session';

/**
 * Whether this browser still has a session this server can open: `204` yes,
 * `401` no. No body, nothing about the session.
 *
 * Asked by a form whose server action call *threw* — Next rejects both a
 * dropped response and the request gate's `401` to an action POST the same way
 * (`request-gate.ts`), and the two mean different things to a person whose
 * command may have committed: "your session has ended, sign in" against "no
 * answer came back, the same request may be sent again" (PR 319 review 1,
 * finding 4). Only this authoritative `401` lets the form say the former.
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const session = await currentSession();
  const response = new NextResponse(null, { status: session ? 204 : 401 });
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
