/**
 * The ceiling on a Server Action's request body, in bytes
 * (`experimental.serverActions.bodySizeLimit`, `next.config.mjs`).
 *
 * A **transport** number, not a policy (ADR-069, Q-98): an attached document
 * reaches the portal as the action's multipart body, and Next's default of 1 MB
 * would refuse almost any file before document-service could say why. It sits
 * just above document-service's own default ceiling (`DOCUMENT_MAX_BYTES`,
 * 25 MiB) so that service, not this setting, refuses an oversize file with a
 * sentence. Read when the portal is **built**: Next bakes it into the build.
 *
 * - `WEB_UPLOAD_MAX_BYTES` — whole bytes. Unset: 26 MiB.
 * - Not below 1 MiB (Next's own default: a smaller number would shrink every
 *   other form too) and not above 200 MiB (document-service's own upper bound
 *   for `DOCUMENT_MAX_BYTES`): a value outside that is a typo, and the build
 *   stops instead of starting a portal that refuses every upload or admits
 *   bodies nobody sized for.
 * - **Global to the portal**: every Server Action may receive a body this large.
 *   ADR-069 records what bounds that and what does not.
 *
 * A CommonJS file so `next.config.mjs` and the unit spec load the same code.
 */

const MIB = 1024 * 1024;

const DEFAULT_UPLOAD_MAX_BYTES = 26 * MIB;
const MIN_UPLOAD_MAX_BYTES = 1 * MIB;
const MAX_UPLOAD_MAX_BYTES = 200 * MIB;

/**
 * @param {string | undefined} raw  the value of `WEB_UPLOAD_MAX_BYTES`
 * @returns {number}                bytes
 */
function uploadMaxBytes(raw) {
  if (raw === undefined || raw.trim() === '') return DEFAULT_UPLOAD_MAX_BYTES;
  const text = raw.trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`WEB_UPLOAD_MAX_BYTES must be a whole number of bytes, got "${raw}"`);
  }
  const bytes = Number(text);
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < MIN_UPLOAD_MAX_BYTES ||
    bytes > MAX_UPLOAD_MAX_BYTES
  ) {
    throw new Error(
      `WEB_UPLOAD_MAX_BYTES must be between ${MIN_UPLOAD_MAX_BYTES} and ${MAX_UPLOAD_MAX_BYTES} bytes, got ${text}`,
    );
  }
  return bytes;
}

module.exports = {
  uploadMaxBytes,
  DEFAULT_UPLOAD_MAX_BYTES,
  MIN_UPLOAD_MAX_BYTES,
  MAX_UPLOAD_MAX_BYTES,
};
