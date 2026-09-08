'use client';

import { useEffect, type ReactNode } from 'react';
import { readPublicEnv } from '@/lib/env';
import { getUserManager } from '@/lib/auth/user-manager';

/**
 * The silent-renew frame.
 *
 * Loaded inside a hidden iframe by `oidc-client-ts` shortly before the access
 * token expires. `signinSilentCallback` posts the new token to the parent
 * window and nothing else happens here — there is no UI because nobody sees
 * this document.
 *
 * This is what makes the in-memory token store workable. docs/16 § 16.11
 * forbids `localStorage` for tokens, so a reload has nothing to restore from;
 * Keycloak's own SSO cookie is the thing that survives, and `prompt=none`
 * through this route is how the application asks it for a fresh token without
 * showing the user a login screen again.
 */
export default function SilentRenewPage(): ReactNode {
  useEffect(() => {
    void (async () => {
      try {
        const manager = await getUserManager(readPublicEnv());
        await manager.signinSilentCallback(window.location.href);
      } catch {
        // The parent's `addSilentRenewError` handler turns this into a signed
        // out session. Nothing useful can be shown inside a hidden iframe.
      }
    })();
  }, []);

  return null;
}
