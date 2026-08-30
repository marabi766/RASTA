/**
 * What a file actually is, read from its first bytes.
 *
 * ADR-014 requires the real content type to be established by magic number and
 * says so twice — "نه پسوند فایل". The reason is narrow and worth stating: a
 * client controls the filename and the `Content-Type` header completely, so
 * both are claims by the uploader about their own upload. Believing either is
 * how an HTML page with a `.pdf` name ends up served back to a browser, and
 * how an executable ends up stored as a "photograph".
 *
 * This inspects a prefix of the object, which is why the finalize step reads a
 * few bytes back from storage rather than trusting what it was told. The file
 * itself still never passes through this service (ADR-014): the largest read
 * here is {@link MAGIC_PREFIX_BYTES}, which is a header, not a document.
 */

/**
 * How many bytes are enough to identify every format on the allowlist.
 *
 * 4096 rather than the ~12 the signatures need, because two of the formats are
 * containers: an Office file is a ZIP whose useful marker is a filename a
 * little way into the archive, and a WebP is a RIFF whose type sits at offset
 * 8. Reading a small fixed header keeps the promise that the service never
 * handles the file while still being enough to refuse a disguise.
 */
export const MAGIC_PREFIX_BYTES = 4096;

/** A content type this service is willing to identify. */
export type DetectedMime =
  | 'application/pdf'
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

interface Signature {
  readonly mime: DetectedMime;
  /** Byte sequence that must appear at `offset`. */
  readonly magic: readonly number[];
  readonly offset: number;
  /**
   * A second marker further into the file.
   *
   * Only the ZIP-based formats need one: every Office document starts with the
   * same four ZIP bytes, so the signature alone cannot tell a spreadsheet from
   * a document — or from an ordinary archive somebody renamed.
   */
  readonly contains?: string;
}

/**
 * The signatures, most specific first.
 *
 * Deliberately short. Every entry here is a format some part of the product
 * actually needs — a scanned licence or contract (PDF), a photograph of damage
 * or a nameplate (JPEG/PNG/WebP), a statement or specification (DOCX/XLSX).
 * Nothing is listed for convenience: an accepted format is an attack surface
 * that has to be validated, stored and eventually rendered by somebody.
 */
const SIGNATURES: readonly Signature[] = [
  { mime: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46], offset: 0 }, // %PDF
  { mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff], offset: 0 },
  { mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], offset: 0 },
  // RIFF....WEBP — the container marker is at 0, the type at 8.
  { mime: 'image/webp', magic: [0x57, 0x45, 0x42, 0x50], offset: 8 },
  {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    magic: [0x50, 0x4b, 0x03, 0x04],
    offset: 0,
    contains: 'word/',
  },
  {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    magic: [0x50, 0x4b, 0x03, 0x04],
    offset: 0,
    contains: 'xl/',
  },
];

function startsWithAt(bytes: Uint8Array, magic: readonly number[], offset: number): boolean {
  if (bytes.length < offset + magic.length) return false;
  for (let i = 0; i < magic.length; i += 1) {
    if (bytes[offset + i] !== magic[i]) return false;
  }
  return true;
}

/**
 * Identifies the content type of a prefix, or `null` when nothing matches.
 *
 * `null` is a refusal, never a fallback. Guessing a type for bytes that match
 * no known signature is how an unsupported format becomes a stored one.
 */
export function detectMime(prefix: Uint8Array): DetectedMime | null {
  // A ZIP container has to be read as text to find its first entry name; every
  // other format is decided by bytes alone.
  let asLatin1: string | null = null;

  for (const signature of SIGNATURES) {
    if (!startsWithAt(prefix, signature.magic, signature.offset)) continue;
    if (!signature.contains) return signature.mime;

    asLatin1 ??= Buffer.from(prefix).toString('latin1');
    if (asLatin1.includes(signature.contains)) return signature.mime;
  }

  return null;
}

/**
 * Whether a declared type may be accepted for a detected one.
 *
 * An exact match, with no aliasing and no "close enough". A client declaring
 * `image/jpg`, or `application/octet-stream` for anything, is refused: the
 * declared type is what other services and the browser will be told later, so
 * letting it drift from the bytes is precisely the mismatch this check exists
 * to catch.
 */
export function declarationMatches(declared: string, detected: DetectedMime): boolean {
  return declared.trim().toLowerCase() === detected;
}
