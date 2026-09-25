import { redirect } from 'next/navigation';
import { readSession } from '@/server/current-session';
import { safeReturnTo } from '@/server/login-attempt';
import { LoginScreen } from './LoginScreen';

/**
 * The `/login` route.
 *
 * Thin on purpose: it reads the session, decides whether this person belongs
 * here, and hands the rest to `LoginScreen`. Everything that needs a request —
 * cookies, redirects — is in this file, and everything that can be rendered in
 * a test is in the other one.
 */
export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Somebody already signed in has no business here; sending them to the
  // dashboard is less confusing than showing a way in they have already used.
  if (await readSession()) redirect('/');

  const params = await searchParams;
  const reason = params.error;
  // Narrowed here, the one place this value is read from the query string —
  // `LoginScreen` gets an already-safe path and stays a plain function of it
  // (`safeReturnTo` is the same check `/auth/login` and the attempt cookie
  // apply again on their own turn, so a caller-supplied absolute URL never
  // reaches a link, cookie or redirect unexamined).
  const returnTo = safeReturnTo(params.returnTo);
  return (
    <LoginScreen reason={typeof reason === 'string' ? reason : undefined} returnTo={returnTo} />
  );
}
