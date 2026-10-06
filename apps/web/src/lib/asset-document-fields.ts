/**
 * The shape of the attach-document form on `/assets/[id]` (EXP-002, slice 7):
 * field names, the closed choice of kinds and a blank set of values.
 *
 * Separate from `server/asset-documents.ts`, which parses these and reaches the
 * gateway client, for the reason `asset-record-fields.ts` gives: that module
 * pulls in `node:crypto` transitively and this file is imported by client
 * components.
 *
 * The form names no asset and no document id. The asset is the page's own,
 * bound to the action (`action.bind(null, assetId)`); the document is the one
 * this server uploaded for the person a moment earlier and signed
 * (`UPLOAD_TOKEN_FIELD`) — there is nothing here a person, or a script, could
 * edit to attach somebody else's document or another machine's.
 */

/** `DOCUMENT_KINDS`, `services/asset-service/src/asset/dto.ts` — pinned by the contract spec. */
export const DOCUMENT_KINDS = [
  'OWNERSHIP_TITLE',
  'REGISTRATION_CARD',
  'INSURANCE_POLICY',
  'TECHNICAL_INSPECTION',
  'PURCHASE_INVOICE',
  'MANUAL',
  'PHOTO',
  'OTHER',
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** The text fields the form keeps across an attempt; the file cannot be kept. */
export const ATTACH_DOCUMENT_TEXT_FIELDS = ['kind', 'title', 'issuedAt', 'expiresAt'] as const;
export type AttachDocumentTextField = (typeof ATTACH_DOCUMENT_TEXT_FIELDS)[number];
export type AttachDocumentFormValues = Record<AttachDocumentTextField, string>;

/** Where an error about the file — or about a field the form cannot place — is shown. */
export type AttachDocumentField = AttachDocumentTextField | 'file';

export const EMPTY_ATTACH_DOCUMENT_FORM: AttachDocumentFormValues = {
  kind: '',
  title: '',
  issuedAt: '',
  expiresAt: '',
};

/** The file input's name. */
export const FILE_FIELD = 'file';

/**
 * The hidden field that carries the signed token of a document this server
 * already uploaded for this submission, so a resend attaches it again instead
 * of uploading the file a second time (`server/asset-documents.ts`).
 */
export const UPLOAD_TOKEN_FIELD = 'uploaded';

/** What the confirmation banner can say, signed into the redirect (`server/flash.ts`). */
export const DOCUMENT_NOTICES = ['documentAttached'] as const;
export type DocumentNotice = (typeof DOCUMENT_NOTICES)[number];
