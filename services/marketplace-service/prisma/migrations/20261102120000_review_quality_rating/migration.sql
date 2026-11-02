-- Q-56: historical reviews have no separate quality answer. Never infer one.
ALTER TABLE "review" ADD COLUMN "quality_rating" INTEGER;
ALTER TABLE "review" ADD CONSTRAINT "ck_review_quality_rating"
  CHECK ("quality_rating" IS NULL OR "quality_rating" BETWEEN 1 AND 5);
