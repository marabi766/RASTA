import { z } from 'zod';

import {
  ATTACH_DOCUMENT_TEXT_FIELDS,
  DOCUMENT_KINDS,
  type AttachDocumentField,
  type AttachDocumentFormValues,
  type AttachDocumentTextField,
  type DocumentKind,
} from '@/lib/asset-document-fields';
import { BIDI_CONTROL } from '@/lib/format';

import {
  BIDI_CONTROL_MESSAGE,
  DATE_MESSAGE,
  RECORD_KEY_REUSED_MESSAGE,
  displayText,
} from './asset-records';
import { firstIssuePerField, readFields } from './asset-commands';
import { localDateToIso } from './drivers';
import { webServerEnv } from './env';
import { signPayload, verifyPayload } from './signed-payload';
import { writeThroughGateway, type FieldMapping, type WriteResult } from './write';
import type { WebSession } from './session';

/**
 * A machine's documents, through the gateway (EXP-002, slice 7; ADR-058 § 3,
 * ADR-059 § 3; the upload relay below is ADR-069; the routing and ceiling it relies on are Q-98).
 *
 * A document on a machine is two things held by two services: the **file**,
 * which document-service keeps (metadata) and object storage holds (bytes), and
 * a **reference** to it that asset-service keeps on the machine. Attaching one
 * is therefore a chain, and this module is where the chain is written down:
 *
 * 1. `POST /v1/documents/upload-url` — document-service checks the declared
 *    class, type and size against *its own* policy and issues a short-lived
 *    signed URL. Nothing about what a file may be is decided here.
 * 2. `PUT` the bytes to that URL. **The portal's server does this, not the
 *    browser**: the page's CSP is `connect-src 'self'`, the storage endpoint is
 *    an internal address and storage has no CORS. The file therefore passes
 *    through the portal server and never through document-service or
 *    asset-service, which is what ADR-014 forbids.
 * 3. `POST /v1/documents` — document-service reads the object back, takes its
 *    size from storage and its type from its first bytes, refuses a mismatch,
 *    and registers it. Repeating this call for one intent returns the same
 *    document.
 * 4. `POST /v1/assets/{id}/documents` — asset-service stores the reference,
 *    under the submission id as `Idempotency-Key`.
 *
 * ## Limits are document-service's
 *
 * This module holds **no** table of allowed types or sizes. It declares what the
 * browser says the file is (`File.type`, `File.size`) and renders document-
 * service's refusal in Persian; the service's answer carries no numbers (its
 * context is internal), so the sentence says "not accepted", never "at most N".
 * The only portal number is the Server Action's transport ceiling
 * (`WEB_UPLOAD_MAX_BYTES`, `upload-limit.cjs`; Q-98), which is not policy.
 *
 * ## A resend is not a second upload
 *
 * Steps 1–3 create a document each time they run, and a step-4 replay under the
 * same key with another `documentId` would be refused as a reused key. So once a
 * document is registered, the action hands the browser a token — signed for this
 * session, this machine and **this submission** — naming it, and a resend of the
 * same submission skips straight to step 4 with the same `documentId`: the
 * replay asset-service recognises. A token for another submission, machine or
 * person is refused like a forged one.
 */

// ---------------------------------------------------------------------------
// Who is offered the form
// ---------------------------------------------------------------------------

/**
 * The roles `POST /v1/assets/:id/documents` admits (`asset.controller.ts`): the
 * same three as the two records, pinned by the contract spec. A Route Guard as
 * UX, exactly as `canManageAssets` documents: it hides a form nobody in another
 * role could use, and is never the check.
 */
const DOCUMENT_ROLES: readonly string[] = ['ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN'];

export const canAttachAssetDocuments = (effectiveRoles: readonly string[]): boolean =>
  effectiveRoles.some((role) => DOCUMENT_ROLES.includes(role));

// ---------------------------------------------------------------------------
// Which asset a form is for, and which document it already uploaded
// ---------------------------------------------------------------------------

const BASELINE_PURPOSE = 'asset-document-baseline';
const UPLOADED_PURPOSE = 'asset-document-uploaded';

/** A registered document is kept by document-service; the token only has to outlive a retry. */
const UPLOADED_TOKEN_TTL_SECONDS = 3600;

const baselineSchema = z.object({ assetId: z.string().min(1).max(200) });
export type AssetDocumentBaseline = z.infer<typeof baselineSchema>;

/**
 * The asset an attach form was drawn for, signed for this session — the binding
 * `sealAssetRecordBaseline` gives the two records (a value bound in a client
 * component is one the browser sends back, so nothing about it is trusted).
 */
export function sealAssetDocumentBaseline(
  session: WebSession,
  baseline: AssetDocumentBaseline,
): string {
  return signPayload(
    session,
    BASELINE_PURPOSE,
    { ...baseline },
    webServerEnv().WEB_SESSION_MAX_AGE_SECONDS,
  );
}

/** The baseline, if `token` is one this session was given; otherwise `null` — one answer for every way it can be wrong. */
export function openAssetDocumentBaseline(
  session: WebSession,
  token: unknown,
): AssetDocumentBaseline | null {
  return verifyPayload(session, BASELINE_PURPOSE, token, baselineSchema);
}

const uploadedSchema = z.object({
  assetId: z.string().min(1).max(200),
  submissionId: z.string().min(1).max(200),
  documentId: z.string().min(1).max(200),
});
export type UploadedDocument = z.infer<typeof uploadedSchema>;

/**
 * The document this server registered for this submission, signed — so a resend
 * attaches the same `documentId` under the same `Idempotency-Key` instead of
 * uploading again. It does not name the kind: the kind is a label asset-service
 * keeps on the reference, the class the file was stored under was decided at
 * upload, and a resend that corrected the kind attaches the same document.
 */
export function sealUploadedDocument(session: WebSession, uploaded: UploadedDocument): string {
  return signPayload(session, UPLOADED_PURPOSE, { ...uploaded }, UPLOADED_TOKEN_TTL_SECONDS);
}

/**
 * The uploaded document, if `token` was issued to this session for exactly this
 * machine and this submission; otherwise `null`.
 */
export function openUploadedDocument(
  session: WebSession,
  token: unknown,
  expected: { readonly assetId: string; readonly submissionId: string },
): UploadedDocument | null {
  const payload = verifyPayload(session, UPLOADED_PURPOSE, token, uploadedSchema);
  if (!payload) return null;
  if (payload.assetId !== expected.assetId || payload.submissionId !== expected.submissionId) {
    return null;
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type { AssetDocumentSummary } from './assets';

/**
 * Where a document's own validity stands at `now` — the server's clock, passed
 * in so a test pins it and a client component, whose clock is the visitor's,
 * never has one. A document with no `expiresAt` never expires; one whose
 * instant cannot be read is `EXPIRED`, never `CURRENT` (the safe side).
 */
export function documentValidityAt(
  expiresAt: string | null,
  now: Date,
): 'NO_EXPIRY' | 'CURRENT' | 'EXPIRED' {
  if (expiresAt === null) return 'NO_EXPIRY';
  const end = Date.parse(expiresAt);
  if (Number.isNaN(end) || Number.isNaN(now.getTime())) return 'EXPIRED';
  return now.getTime() >= end ? 'EXPIRED' : 'CURRENT';
}

// ---------------------------------------------------------------------------
// Which document-service class a kind is stored under
// ---------------------------------------------------------------------------

/**
 * `DOCUMENT_CLASSES`, `services/document-service/src/content/policy.ts` — the
 * class decides only what a file may *technically* be (formats and ceiling).
 *
 * Which class an asset-document kind is filed under is a routing choice, not a
 * legal rule, and it decides the limits (Q-98). The default
 * is conservative: a kind that names a class exactly goes to it; a kind that
 * says nothing about the file's form goes to `OTHER`, the narrowest class (PDF,
 * JPEG, PNG, smallest ceiling) — so a wrong guess refuses a file rather than
 * admitting one. Pinned by the contract spec to both services' vocabularies.
 */
export const DOCUMENT_CLASS_BY_KIND: Readonly<Record<DocumentKind, string>> = {
  OWNERSHIP_TITLE: 'OTHER',
  REGISTRATION_CARD: 'OTHER',
  INSURANCE_POLICY: 'INSURANCE_POLICY',
  TECHNICAL_INSPECTION: 'INSPECTION_REPORT',
  PURCHASE_INVOICE: 'OTHER',
  MANUAL: 'OTHER',
  PHOTO: 'DAMAGE_PHOTO',
  OTHER: 'OTHER',
};

// ---------------------------------------------------------------------------
// What a person types
// ---------------------------------------------------------------------------

/**
 * The lengths asset-service bounds the title by (`attachDocumentSchema`:
 * `displayText(2, 200)`) — pinned by the contract spec, which reads them out of
 * the service's source.
 */
export const DOCUMENT_BOUNDS = { title: { min: 2, max: 200 } } as const;

/** An optional calendar day, as the Tehran-midnight instant the service takes. */
const optionalDate = z.string().transform((raw, ctx): string | undefined => {
  if (raw.trim() === '') return undefined;
  const iso = localDateToIso(raw);
  if (iso === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: DATE_MESSAGE });
    return z.NEVER;
  }
  return iso;
});

export function attachDocumentFormValues(form: FormData): AttachDocumentFormValues {
  return readFields(form, ATTACH_DOCUMENT_TEXT_FIELDS);
}

export const attachDocumentFormSchema = z
  .object({
    kind: z.enum(DOCUMENT_KINDS, {
      errorMap: () => ({ message: 'نوع مدرک را از فهرست انتخاب کنید' }),
    }),
    title: displayText('عنوان', DOCUMENT_BOUNDS.title.min, DOCUMENT_BOUNDS.title.max).refine(
      (value) => !BIDI_CONTROL.test(value),
      BIDI_CONTROL_MESSAGE,
    ),
    issuedAt: optionalDate,
    expiresAt: optionalDate,
  })
  .strict()
  // A blank optional is absent, not `undefined`: the body is what the service reads.
  .transform(({ issuedAt, expiresAt, ...rest }) => ({
    ...rest,
    ...(issuedAt !== undefined ? { issuedAt } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  }));

/** What asset-service accepts on `POST /v1/assets/{id}/documents`, less the `documentId` the upload produced. */
export type AttachDocumentBody = z.output<typeof attachDocumentFormSchema>;

export type ParsedAttachForm =
  | { readonly ok: true; readonly body: AttachDocumentBody }
  | {
      readonly ok: false;
      readonly fieldErrors: Partial<Record<AttachDocumentField, string>>;
    };

export function parseAttachDocumentForm(values: AttachDocumentFormValues): ParsedAttachForm {
  const parsed = attachDocumentFormSchema.safeParse(values);
  if (parsed.success) return { ok: true, body: parsed.data };
  return {
    ok: false,
    fieldErrors: firstIssuePerField(parsed.error, (value): value is AttachDocumentTextField =>
      (ATTACH_DOCUMENT_TEXT_FIELDS as readonly string[]).includes(value),
    ),
  };
}

/** What the person chose in the file input, or why there is nothing to send. */
export type ChosenFile =
  { readonly ok: true; readonly file: File } | { readonly ok: false; readonly message: string };

export const FILE_MISSING_MESSAGE = 'فایل مدرک را انتخاب کنید';
export const FILE_EMPTY_MESSAGE = 'فایل انتخاب‌شده خالی است';

/**
 * An input with nothing chosen reaches a Server Action as a zero-byte `File`
 * with **no name** — an empty one on a plain post, and the string `"undefined"`
 * through React's action transport (seen in the live browser scenario, #225).
 * Both mean "nothing was chosen", and the person is told to choose a file,
 * not that the file they never picked is empty. A zero-byte file with a real
 * name is one they did pick, and is refused as empty below.
 */
function isNoSelection(file: File): boolean {
  return file.name === '' || (file.size === 0 && file.name === 'undefined');
}

/**
 * Only whether there is a file, and whether it has any bytes. Whether its type
 * or size is acceptable is document-service's to say — it is asked, not copied.
 */
export function chosenFile(form: FormData, field: string): ChosenFile {
  const value = form.get(field);
  if (!(value instanceof File) || isNoSelection(value)) {
    return { ok: false, message: FILE_MISSING_MESSAGE };
  }
  if (value.size === 0) return { ok: false, message: FILE_EMPTY_MESSAGE };
  return { ok: true, file: value };
}

// ---------------------------------------------------------------------------
// What the services say, in Persian
// ---------------------------------------------------------------------------

/** document-service's refusal at step 1 or 3, said without a number it does not send. */
export const FILE_TYPE_NOT_ACCEPTED_MESSAGE =
  'این نوع فایل برای این نوع مدرک پذیرفته نمی‌شود. فایل PDF یا تصویر (JPEG یا PNG) بفرستید، یا نوع مدرک را عوض کنید.';
export const FILE_TOO_LARGE_MESSAGE =
  'حجم فایل از حد مجاز این نوع مدرک بیشتر است. فایل کم‌حجم‌تری بفرستید یا نوع مدرک را عوض کنید.';
export const FILE_CONTENT_MISMATCH_MESSAGE =
  'محتوای فایل با نوعی که اعلام شده یکی نیست؛ فایل اصلی را دوباره انتخاب کنید.';
export const UPLOAD_EXPIRED_MESSAGE =
  'مهلت بارگذاری این فایل تمام شد. فایل را دوباره انتخاب کنید و بفرستید.';
export const FILE_NOT_STORED_MESSAGE =
  'فایل در محل نگهداری ثبت نشد. دوباره بفرستید؛ اگر تکرار شد، با پشتیبانی تماس بگیرید.';
export const FILE_NAME_REFUSED_MESSAGE =
  'نام این فایل پذیرفته نشد. نام آن را کوتاه و بدون نویسهٔ نامرئی کنید و دوباره انتخاب کنید.';
export const GENERIC_UPLOAD_REFUSED_MESSAGE =
  'فایل پذیرفته نشد. نوع و حجم آن را بررسی کنید و دوباره تلاش کنید.';

/**
 * The sentences document-service sends for a refusal this module words
 * (`content/policy.ts`, `document.service.ts`) — pinned by the contract spec,
 * which reads each out of the service's source. A sentence not listed is shown
 * as it arrived: visibly foreign, never hidden.
 */
export const DOCUMENT_SERVICE_MESSAGES: Readonly<Record<string, string>> = {
  'This content type is not accepted for this document class': FILE_TYPE_NOT_ACCEPTED_MESSAGE,
  'The uploaded content type is not accepted for this class': FILE_TYPE_NOT_ACCEPTED_MESSAGE,
  'The uploaded content is not a supported document format': FILE_TYPE_NOT_ACCEPTED_MESSAGE,
  'The declared size exceeds the limit for this document class': FILE_TOO_LARGE_MESSAGE,
  'The uploaded object exceeds the limit for this class': FILE_TOO_LARGE_MESSAGE,
  'An empty file cannot be uploaded': FILE_EMPTY_MESSAGE,
  'The uploaded object is empty': FILE_EMPTY_MESSAGE,
  'The uploaded content does not match the declared content type': FILE_CONTENT_MISMATCH_MESSAGE,
  'This upload intent has expired': UPLOAD_EXPIRED_MESSAGE,
  'The uploaded object changed after it was inspected; upload again': FILE_CONTENT_MISMATCH_MESSAGE,
  'No object was uploaded for this intent': FILE_NOT_STORED_MESSAGE,
  'The uploaded object carries no verifiable checksum': FILE_NOT_STORED_MESSAGE,
};

export const DOCUMENT_SERVICE_MAPPING: FieldMapping<'file'> = {
  paths: { documentClass: 'file', contentType: 'file', sizeBytes: 'file', filename: 'file' },
  messages: DOCUMENT_SERVICE_MESSAGES,
  // A 400 on the declaration names the file's own properties; the sentence is
  // the platform's validation wording, so the code stands in for it.
  byCode: { VALIDATION_FAILED: FILE_NAME_REFUSED_MESSAGE },
};

/** Said when asset-service refuses the reference after the file is registered. */
export const DOCUMENT_REFERENCE_REFUSED_MESSAGE =
  'فایل بارگذاری شد اما پیوست آن به دارایی پذیرفته نشد. اطلاعات را بررسی کنید و دوباره بفرستید؛ فایل دوباره بارگذاری نمی‌شود.';

const ATTACH_MESSAGES: Readonly<Record<string, string>> = {
  'This Idempotency-Key was already used with a different request body': RECORD_KEY_REUSED_MESSAGE,
};

export const ATTACH_MAPPING: FieldMapping<AttachDocumentTextField> = {
  paths: { kind: 'kind', title: 'title', issuedAt: 'issuedAt', expiresAt: 'expiresAt' },
  messages: ATTACH_MESSAGES,
  byCode: { IDEMPOTENCY_KEY_REUSED: RECORD_KEY_REUSED_MESSAGE },
};

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

const uploadIntentSchema = z.object({
  uploadIntentId: z.string().min(1),
  uploadUrl: z.string().min(1),
});

const registeredSchema = z.object({ id: z.string().min(1) });

/**
 * How long the portal waits for storage to take the bytes. Named, like the
 * gateway's own deadline: storage that accepts the connection and then stalls
 * would otherwise hold the action for as long as the runtime's socket timeout.
 */
export const STORAGE_UPLOAD_TIMEOUT_MS = 120_000;

/** `document-service` and the signed URL it issues only ever speak HTTP(S). */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export type UploadOutcome =
  /** The file is registered with document-service; step 4 can run. */
  | { readonly kind: 'REGISTERED'; readonly documentId: string }
  /** document-service refused the file; `message` is what the person reads. */
  | { readonly kind: 'REFUSED'; readonly message: string }
  | { readonly kind: 'FORBIDDEN'; readonly correlationId: string }
  /** Nothing was registered and nothing needs cleaning up. */
  | { readonly kind: 'FAILED'; readonly status: number; readonly correlationId: string }
  /**
   * Registration was sent and not confirmed. A document may now exist that
   * nothing references — an orphan document-service holds in this organization
   * and no machine lists — which a resend simply does not reuse.
   */
  | { readonly kind: 'UNCONFIRMED'; readonly correlationId: string };

export interface UploadCall {
  readonly assetId: string;
  readonly kind: DocumentKind;
  readonly file: File;
  readonly submissionId: string;
  readonly fetchImpl?: typeof fetch;
  /** Storage is not the gateway; tests inject it separately. */
  readonly storageFetchImpl?: typeof fetch;
}

function refusalText(result: Extract<WriteResult<unknown, 'file'>, { kind: 'INVALID' }>): string {
  return result.fieldErrors.file ?? result.message ?? GENERIC_UPLOAD_REFUSED_MESSAGE;
}

/**
 * Steps 1 to 3: the file, from the browser's hands to a registered document.
 *
 * Stops at the first step that does not succeed and says which kind of failure
 * it was — a refusal to word, a failure that left nothing behind, or an
 * unconfirmed registration — so the caller never reports "nothing was saved"
 * for a step that may have been.
 */
export async function uploadDocument(
  session: WebSession,
  call: UploadCall,
): Promise<UploadOutcome> {
  const documentClass = DOCUMENT_CLASS_BY_KIND[call.kind];
  const contentType = call.file.type;

  // 1. Ask document-service whether this may be uploaded, and for the URL.
  const intent = await writeThroughGateway(session, {
    path: '/v1/documents/upload-url',
    body: {
      documentClass,
      contentType: contentType === '' ? 'application/octet-stream' : contentType,
      sizeBytes: call.file.size,
      filename: call.file.name,
    },
    submissionId: call.submissionId,
    schema: uploadIntentSchema,
    mapping: DOCUMENT_SERVICE_MAPPING,
    fetchImpl: call.fetchImpl,
  });
  switch (intent.kind) {
    case 'CREATED':
      break;
    case 'INVALID':
      return { kind: 'REFUSED', message: refusalText(intent) };
    case 'FORBIDDEN':
      return { kind: 'FORBIDDEN', correlationId: intent.correlationId };
    case 'NOT_FOUND':
      return { kind: 'FAILED', status: 404, correlationId: intent.correlationId };
    case 'UNAVAILABLE':
      return { kind: 'FAILED', status: intent.status, correlationId: intent.correlationId };
    case 'IN_PROGRESS':
    case 'UNKNOWN_OUTCOME':
      // An intent is only a permission; no document exists yet.
      return { kind: 'FAILED', status: 503, correlationId: intent.correlationId };
  }

  // 2. The bytes, from this server to storage. The URL is a credential: it is
  //    used here and nowhere else — never logged, never put in an error.
  const url = intent.data.uploadUrl;
  if (!isHttpUrl(url)) {
    return { kind: 'FAILED', status: 502, correlationId: intent.correlationId };
  }
  try {
    const stored = await (call.storageFetchImpl ?? fetch)(url, {
      method: 'PUT',
      // The type is bound into the signature, so it is sent exactly as declared.
      headers: { 'content-type': contentType === '' ? 'application/octet-stream' : contentType },
      body: new Uint8Array(await call.file.arrayBuffer()),
      // A redirect would carry the signed request to a host nobody chose.
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(STORAGE_UPLOAD_TIMEOUT_MS),
    });
    if (!stored.ok) {
      return { kind: 'FAILED', status: stored.status, correlationId: intent.correlationId };
    }
  } catch {
    return { kind: 'FAILED', status: 503, correlationId: intent.correlationId };
  }

  // 3. Register it. The owner reference is recorded and never resolved.
  const registered = await writeThroughGateway(session, {
    path: '/v1/documents',
    body: {
      uploadIntentId: intent.data.uploadIntentId,
      ownerResourceType: 'Asset',
      ownerResourceId: call.assetId,
    },
    submissionId: call.submissionId,
    schema: registeredSchema,
    mapping: DOCUMENT_SERVICE_MAPPING,
    fetchImpl: call.fetchImpl,
  });
  switch (registered.kind) {
    case 'CREATED':
      return { kind: 'REGISTERED', documentId: registered.data.id };
    case 'INVALID':
      return { kind: 'REFUSED', message: refusalText(registered) };
    case 'FORBIDDEN':
      return { kind: 'FORBIDDEN', correlationId: registered.correlationId };
    case 'NOT_FOUND':
      return { kind: 'FAILED', status: 404, correlationId: registered.correlationId };
    case 'UNAVAILABLE':
      return { kind: 'FAILED', status: registered.status, correlationId: registered.correlationId };
    case 'IN_PROGRESS':
    case 'UNKNOWN_OUTCOME':
      return { kind: 'UNCONFIRMED', correlationId: registered.correlationId };
  }
}

const attachedSchema = z.object({ id: z.string().min(1) });
export type AttachedDocument = z.infer<typeof attachedSchema>;

/**
 * Step 4: the reference on the machine. The bound submission id is the
 * `Idempotency-Key`: asset-service stores the answer under it, so a second send
 * of the same submission — with the same `documentId`, which is why the upload
 * token exists — is the first one's response and attaches nothing.
 */
export function attachAssetDocument(
  session: WebSession,
  assetId: string,
  documentId: string,
  body: AttachDocumentBody,
  submissionId: string,
  fetchImpl?: typeof fetch,
): Promise<WriteResult<AttachedDocument, AttachDocumentTextField>> {
  return writeThroughGateway(session, {
    // The id goes in a path segment, so it is encoded rather than interpolated.
    path: `/v1/assets/${encodeURIComponent(assetId)}/documents`,
    body: { documentId, ...body },
    submissionId,
    schema: attachedSchema,
    mapping: ATTACH_MAPPING,
    fetchImpl,
  });
}
