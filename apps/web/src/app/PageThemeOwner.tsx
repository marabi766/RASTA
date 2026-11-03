import { themeOwnerFor } from '@/server/theme';
import { ThemeOwner } from '@/ui';

/**
 * Whose theme this page keeps, delivered with the page itself.
 *
 * `subject` is the signed-in person's id, or `null` on a page with no login
 * (the device's own cookie). Every page renders one — the shell through
 * `PortalSidebar`, the three shell-less screens directly, and
 * `theme-switch-coverage.spec.tsx` holds a new page to it. Not the root layout:
 * Next keeps that across a soft navigation, so after another tab changed the
 * account it would still name the old one (PR 595 review, F1). If the owner
 * cannot be computed nothing is rendered, and the page has no switch.
 */
export function PageThemeOwner({ subject }: { subject: string | null }) {
  const owner = themeOwnerFor(subject);
  return owner ? <ThemeOwner cookieName={owner.cookieName} secure={owner.secure} /> : null;
}
