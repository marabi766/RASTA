-- =============================================================================
-- organization-service — one external code, however it is typed (FU-084).
--
-- `organization_external_code_key` compared bytes, so a code typed with the Arabic ي or ك, Persian
-- digits, a zero-width joiner, U+034F or a bidi mark could stand beside the code a person cannot
-- tell it from, and each org would answer to "the same" government code. The request schema now
-- canonicalises it (`uniqueText({ caseFold: false })` of @rasta/nest-common); here the database
-- refuses anything else and compares the key, whatever the code forgets. Case is not folded: an
-- issuing authority may mean it.
--
-- `organization_text_is_canonical` is `isCanonicalUniqueText` and `organization_text_key` is
-- `uniqueTextKey`; `test/canonical-external-code.int-spec.ts` runs both sides over every code point.
-- The form, in short: printable ASCII, the Persian alphabet with its hamza letters, ، ؛ ؟ ٪ « »; one
-- space between words; U+0654 only after heh; the half-space only between Persian letters, and it is
-- not part of the key.
--
-- Fail closed: a stored code outside the form, or two that share a key, stops this migration for a
-- person to decide. The pre-deploy query is in docs/runbooks/canonical-unique-text.md.
-- =============================================================================
SET LOCAL lock_timeout = '3s';

CREATE FUNCTION "organization_text_is_canonical"("candidate" TEXT) RETURNS BOOLEAN
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN "candidate" ~ U&'^[\0020-\007E\00AB\00BB\060C\061B\061F\066A\0621-\063A\0641\0642\0644-\0648\067E\0686\0698\06A9\06AF\06CC\0654\200C]+$'
    AND "candidate" !~ U&'^[\0020\200C]|[\0020\200C]$|[\0020\200C]{2}'
    AND "candidate" !~ U&'(^|[^\0647])\0654'
    AND "candidate" !~ U&'(^|[^\0621-\063A\0641\0642\0644-\0648\067E\0686\0698\06A9\06AF\06CC\0654])\200C|\200C($|[^\0621-\063A\0641\0642\0644-\0648\067E\0686\0698\06A9\06AF\06CC])';

CREATE FUNCTION "organization_text_key"("canonical_text" TEXT) RETURNS TEXT
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN replace("canonical_text", U&'\200C', '');

GRANT EXECUTE ON FUNCTION "organization_text_is_canonical"(TEXT) TO rasta_organization;
GRANT EXECUTE ON FUNCTION "organization_text_key"(TEXT) TO rasta_organization;

ALTER TABLE "organization" ADD CONSTRAINT "ck_organization_external_code_canonical"
  CHECK ("external_code" IS NULL
         OR (char_length("external_code") <= 64 AND "organization_text_is_canonical"("external_code")));

-- Global, deleted rows included, as the byte index was.
DROP INDEX "organization_external_code_key";
CREATE UNIQUE INDEX "ux_organization_external_code_key"
  ON "organization"("organization_text_key"("external_code"));
