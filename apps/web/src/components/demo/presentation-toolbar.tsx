'use client';

import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button, Card } from '../ui/primitives';
import { DemoModeChip } from './mode-banner';
import { useTour } from './tour-provider';

/** The routes that own the toolbar. Everywhere else it does not exist. */
const PRESENTATION_ROUTES = ['/demo', '/present'];

export function isPresentationRoute(pathname: string): boolean {
  return PRESENTATION_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );
}

/**
 * Presenter controls, on the presentation routes only.
 *
 * Deliberately absent from the product screens. A toolbar that followed the
 * presenter into `/assets` would be on screen during the part of the demo where
 * the audience is supposed to be looking at the product, and a full-screen
 * button next to a real asset register is an invitation to press it by
 * accident mid-sentence.
 */
export function PresentationToolbar(): ReactNode {
  const pathname = usePathname();
  const { active, detailed, setDetailed, restart, start } = useTour();

  if (!isPresentationRoute(pathname)) return null;

  return (
    <Card className="mb-6 flex flex-wrap items-center gap-2 border-[var(--pri)]">
      <span className="me-auto text-xs font-bold text-[var(--tx3)]">ابزار ارائه</span>

      <DemoModeChip />

      <Button variant="secondary" onClick={() => setDetailed(!detailed)}>
        {detailed ? 'متن کوتاه' : 'متن کامل'}
      </Button>

      <Button variant="secondary" onClick={active ? restart : start}>
        {active ? 'از ابتدای روایت' : 'شروع روایت'}
      </Button>

      <CopyLinkButton />
      <FullscreenButton />
    </Card>
  );
}

/**
 * Copies the current URL.
 *
 * The origin and pathname only — `search` and `hash` are dropped rather than
 * copied. Nothing in this application puts a credential in a query string, and
 * a link a presenter pastes into a chat window is exactly where one would do
 * the most damage if it ever did; building the link from parts means a future
 * query parameter cannot arrive in a shared link by default.
 */
function CopyLinkButton(): ReactNode {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = useCallback(() => {
    const link = `${window.location.origin}${window.location.pathname}`;

    void navigator.clipboard
      ?.writeText(link)
      .then(() => setCopied(true))
      // A refused clipboard permission is not worth an error dialog during a
      // presentation. The address bar still has the URL.
      .catch(() => setCopied(false));
  }, []);

  return (
    <Button variant="secondary" onClick={copy}>
      {copied ? 'کپی شد' : 'کپی نشانی'}
    </Button>
  );
}

/**
 * Full screen, where the browser allows it.
 *
 * The API is permission-gated and rejects when it was not called from a user
 * gesture, and it is absent altogether in some embedded browsers. A rejection
 * is swallowed: the presenter can still press F11, and a modal apologising for
 * a missing convenience is worse than the missing convenience.
 */
function FullscreenButton(): ReactNode {
  const [supported, setSupported] = useState(false);
  const [isFull, setIsFull] = useState(false);

  useEffect(() => {
    setSupported(typeof document.documentElement.requestFullscreen === 'function');

    const onChange = (): void => setIsFull(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggle = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    void document.documentElement.requestFullscreen().catch(() => undefined);
  }, []);

  if (!supported) return null;

  return (
    <Button variant="secondary" onClick={toggle}>
      {isFull ? 'خروج از تمام‌صفحه' : 'تمام‌صفحه'}
    </Button>
  );
}
