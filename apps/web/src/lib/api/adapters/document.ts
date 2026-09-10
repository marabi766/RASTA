import { z } from 'zod';
import type { AdapterDescriptor } from '../adapter';
import type { GatewayClient } from '../client';

/**
 * Document metadata from `document-service`.
 *
 * Metadata only, and that is a property of the service rather than a choice
 * made here: the response **never** carries the object key, the bucket or a
 * URL. Anything that could read the key could try to reach the object with
 * credentials obtained elsewhere, bypassing every check the service makes, so
 * the key does not cross the API boundary at all (S-09, ADR-014).
 *
 * ## Why this milestone lists but does not download or upload
 *
 * Both are possible and both are real contracts. Neither is shown, for reasons
 * that are about the demo rather than the code:
 *
 *  - **Download** requires `POST /v1/documents/{id}/download-url`, which
 *    *issues a credential* rather than reading state. It is fail-closed: only
 *    `CLEAN` is ever handed over, and a fresh document is `PENDING` and answers
 *    `422`. A demo button that fails correctly on almost every row teaches the
 *    audience the wrong thing about a control that is working.
 *  - **Upload** is a five-step direct-to-storage flow that writes to a shared
 *    bucket and to a shared database. This session must not mutate shared
 *    infrastructure.
 *
 * So the screen reports scan state honestly instead, which is the part with
 * something to say (ADR-049).
 *
 * Shapes read from `services/document-service/src/document/dto.ts`.
 */

export const DOCUMENT_ADAPTER = {
  id: 'document.registry',
  service: 'document-service',
  routes: ['GET /v1/documents', 'GET /v1/documents/{id}'],
} as const satisfies AdapterDescriptor;

export const documentViewSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  documentClass: z.string(),
  status: z.enum(['REGISTERED', 'DELETED']),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  filename: z.string(),

  /** The only value that permits a download is `CLEAN`. */
  scanState: z.enum(['PENDING', 'NOT_SCANNED', 'CLEAN', 'INFECTED', 'FAILED']),
  /** Whether an engine reached a conclusion about these bytes. */
  scanInspectedContent: z.boolean(),
  scanEngine: z.string().nullable(),
  /** The signature database that answered, so a clean verdict can be dated. */
  scanSignatureVersion: z.string().nullable(),
  scanSignature: z.string().nullable(),
  /** A fixed reason code. Never engine text. */
  scanFailureReason: z.string().nullable(),
  quarantinedAt: z.string().nullable(),
  scannedAt: z.string().nullable(),

  ownerResourceType: z.string().nullable(),
  ownerResourceId: z.string().nullable(),
  createdAt: z.string(),
  createdBy: z.string(),
  deletedAt: z.string().nullable(),
  deletionReason: z.string().nullable(),
});

export type DocumentView = z.infer<typeof documentViewSchema>;

/**
 * What each scan state actually means.
 *
 * Written out because the difference between `PENDING` and `NOT_SCANNED` is the
 * kind of thing a UI usually flattens into "unknown", and they are not the
 * same: one is a scan that has not finished, the other is a document no engine
 * ever looked at. Both are undownloadable, for different reasons.
 */
export const SCAN_STATE_PRESENTATION: Record<
  DocumentView['scanState'],
  { label: string; meaning: string; downloadable: boolean }
> = {
  CLEAN: {
    label: 'پاک',
    meaning: 'موتور بدافزاریابی روی بایت‌های واقعی این فایل نتیجه گرفت و چیزی پیدا نکرد.',
    downloadable: true,
  },
  PENDING: {
    label: 'در انتظار بررسی',
    meaning:
      'اسکن ناهمزمان است و هر سند تازه در همین وضعیت ثبت می‌شود. تا پایان بررسی، دانلود رد می‌شود.',
    downloadable: false,
  },
  NOT_SCANNED: {
    label: 'بررسی‌نشده',
    meaning: 'هیچ موتوری به بایت‌های این فایل نگاه نکرده است — با «پاک» یکی نیست.',
    downloadable: false,
  },
  INFECTED: {
    label: 'آلوده',
    meaning: 'موتور، امضای بدافزار را تشخیص داد. فایل قرنطینه می‌شود و هرگز تحویل داده نمی‌شود.',
    downloadable: false,
  },
  FAILED: {
    label: 'بررسی ناموفق',
    meaning: 'اسکن به نتیجه نرسید. سیاست Fail-Closed است: نرسیدن به نتیجه، مجوز دانلود نمی‌دهد.',
    downloadable: false,
  },
};

/** `DOCUMENT_CLASSES` from `document-service/src/content/policy.ts`. */
export const DOCUMENT_CLASS_LABELS: Record<string, string> = {
  CONTRACT: 'قرارداد',
  INSURANCE_POLICY: 'بیمه‌نامه',
  TENDER_DOCUMENT: 'اسناد مناقصه',
  STATEMENT: 'صورت‌وضعیت',
  SUPPLIER_CREDENTIAL: 'مدرک تأمین‌کننده',
  INSPECTION_REPORT: 'گزارش بازدید',
  DAMAGE_PHOTO: 'عکس خسارت',
  PROGRESS_REPORT: 'گزارش پیشرفت',
  OTHER: 'سایر',
};

export async function listDocuments(
  client: GatewayClient,
  signal?: AbortSignal,
): Promise<DocumentView[]> {
  const result = await client.request({
    // `{ items, nextCursor }` — this service returns no `hasMore`.
    path: '/v1/documents',
    schema: z.object({
      items: z.array(documentViewSchema),
      nextCursor: z.string().nullable(),
    }),
    signal,
    query: { limit: 50 },
  });

  return result.data.items;
}
