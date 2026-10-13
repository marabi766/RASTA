/**
 * The civil-works project vocabulary the `/projects` screens render
 * (docs/16 § ۱۶٫۶; construction-service `ProjectStatus`).
 *
 * The portal does not enforce this on a response: a status it has no word for
 * renders as itself, visibly untranslated, rather than refusing the page
 * (`assets.ts` explains why). It does use it for the list filter, where
 * anything outside it is dropped instead of being forwarded to earn a 400.
 */
export const PROJECT_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'CHANGES_REQUESTED',
  'APPROVED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_STATUS_LABELS: Readonly<Record<ProjectStatus, string>> = {
  DRAFT: 'پیش‌نویس',
  PENDING_APPROVAL: 'در انتظار موافقت',
  CHANGES_REQUESTED: 'نیازمند اصلاح',
  APPROVED: 'تأییدشده',
  IN_PROGRESS: 'در حال اجرا',
  COMPLETED: 'تکمیل‌شده',
  CANCELLED: 'لغوشده',
};

export function isProjectStatus(value: string | undefined): value is ProjectStatus {
  return (PROJECT_STATUSES as readonly string[]).includes(value ?? '');
}

export function projectStatusLabel(status: string): string {
  return isProjectStatus(status) ? PROJECT_STATUS_LABELS[status] : status;
}
