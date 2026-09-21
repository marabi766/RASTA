import { redirect } from 'next/navigation';
import { readSession } from '@/server/current-session';
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

  const raw = (await searchParams).error;
  return <LoginScreen reason={typeof raw === 'string' ? raw : undefined} />;
}
