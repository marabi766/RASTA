-- =============================================================================
-- identity-service — one person, one login name, however it is typed (FU-084).
--
-- `user_username_key` and `user_email_key` compare bytes, so `Ali` and `ali`, or an address with a
-- zero-width joiner, a combining grapheme joiner or a bidi mark in it, could each hold an account
-- beside the one a person cannot tell it from. The request schemas already fold to lower case
-- (`uniqueText({ caseFold: true })` of @rasta/nest-common for the username; `toLowerCase` for the
-- email) and admit only ASCII; this makes the database say the same, whatever the code forgets:
--
--   * a username or an email is printable ASCII and nothing else: no blank, no invisible character,
--     no lookalike from another script;
--   * two that differ only in the case of A–Z are one: `user_login_key` is `foldAsciiCase`, and
--     `test/canonical-login-key.int-spec.ts` compares the two over every code point. `translate`, not
--     `lower()`, so the key is the same under every collation.
--
-- The byte indexes stay: Prisma names them in `findUnique`.
--
-- Fail closed: a stored value outside the form, or two that share a key, stops this migration for a
-- person to decide. The pre-deploy query that finds them is in docs/runbooks/canonical-unique-text.md.
-- =============================================================================
SET LOCAL lock_timeout = '3s';

CREATE FUNCTION "user_login_key"("login" TEXT) RETURNS TEXT
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN translate("login", 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz');

GRANT EXECUTE ON FUNCTION "user_login_key"(TEXT) TO rasta_identity;

ALTER TABLE "user" ADD CONSTRAINT "ck_user_login_printable_ascii"
  CHECK ("username" ~ U&'^[\0021-\007E]+$' AND "email" ~ U&'^[\0021-\007E]+$');

CREATE UNIQUE INDEX "ux_user_username_login_key" ON "user"("user_login_key"("username"));
CREATE UNIQUE INDEX "ux_user_email_login_key" ON "user"("user_login_key"("email"));
