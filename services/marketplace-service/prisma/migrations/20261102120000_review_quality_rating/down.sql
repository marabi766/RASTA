-- Only the new quality answers are lost on rollback; reviews remain intact.
ALTER TABLE "review" DROP CONSTRAINT "ck_review_quality_rating";
ALTER TABLE "review" DROP COLUMN "quality_rating";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261102120000_review_quality_rating';
