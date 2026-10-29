-- Reverses 20261029120000_user_provisioning_intent.
--
-- Destructive for recovery only: a provisioning whose account was created but
-- whose user row never committed can no longer be adopted by a retry, and its
-- username stays taken in Keycloak until an operator deletes that disabled,
-- grantless account (the state before this migration). Users already
-- provisioned are unaffected; nothing else is touched.
DROP TABLE IF EXISTS "user_provisioning_intent";

-- Prisma will not re-apply a migration whose row is still in its ledger.
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261029120000_user_provisioning_intent';
