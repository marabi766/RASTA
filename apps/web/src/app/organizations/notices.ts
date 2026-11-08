/**
 * The confirmations an organizations-page write leaves (`server/flash.ts`):
 * signed for this session and organization, never a typed flag (PR 405 review
 * 2, F2 — they used to be `?saved=profile`, `?saved=roles`, `?revoked=1`).
 */
export const ORGANIZATION_FLASH_SUBJECT = 'organization';

export const ORGANIZATION_NOTICES = ['profile', 'roles', 'revoked'] as const;

export type OrganizationNotice = (typeof ORGANIZATION_NOTICES)[number];
