-- FU-188: `bid_opening_at` and `bid_closing_at` are timestamptz. Read into timestamp(3) variables
-- they went through the session's wall clock and came back on the comparison with
-- clock_timestamp(): in a zone with daylight saving, a window edge in the repeated hour moved
-- by an hour. The variables now have the columns' type. Nothing else in the body changes.
CREATE OR REPLACE FUNCTION "bid_guard"() RETURNS trigger AS $$
DECLARE
  tender_status text;
  opens timestamptz(3);
  closes timestamptz(3);
  judged boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ck_bid_immutable: a bid is never deleted'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" <> OLD."id" OR NEW."organization_id" <> OLD."organization_id"
       OR NEW."tender_id" <> OLD."tender_id"
       OR NEW."bidder_organization_id" <> OLD."bidder_organization_id"
       OR NEW."submitted_at" <> OLD."submitted_at" THEN
      RAISE EXCEPTION 'ck_bid_immutable: the identity of a bid never changes'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."revision" <> OLD."revision" AND NEW."revision" <> OLD."revision" + 1 THEN
      RAISE EXCEPTION 'ck_bid_revision_step: a revision is the next one'
        USING ERRCODE = 'check_violation';
    END IF;

    -- The sealed bytes change only with a new revision, which is a new seal.
    IF NEW."revision" = OLD."revision"
       AND (NEW."ciphertext" <> OLD."ciphertext" OR NEW."nonce" <> OLD."nonce"
            OR NEW."tag" <> OLD."tag" OR NEW."wrapped_content_key" <> OLD."wrapped_content_key"
            OR NEW."content_commitment" <> OLD."content_commitment"
            OR NEW."ciphertext_sha256" <> OLD."ciphertext_sha256") THEN
      RAISE EXCEPTION 'ck_bid_immutable: sealed content changes only with a new revision'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."status" <> OLD."status" AND NOT (
         (OLD."status"::text = 'SUBMITTED' AND NEW."status"::text IN ('WITHDRAWN', 'OPENED'))
      OR (OLD."status"::text = 'OPENED' AND NEW."status"::text IN ('QUALIFIED', 'DISQUALIFIED'))
      OR (OLD."status"::text = 'QUALIFIED' AND NEW."status"::text IN ('AWARDED', 'NOT_AWARDED'))
    ) THEN
      RAISE EXCEPTION 'ck_bid_status_transition: a bid cannot go from % to %', OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;

    -- A replacement of the seal, or a withdrawal, is a bidder's act inside the window.
    judged := NEW."revision" <> OLD."revision" OR NEW."status"::text = 'WITHDRAWN';
  ELSE
    judged := true;
  END IF;

  IF judged THEN
    SELECT "status"::text, "bid_opening_at", "bid_closing_at"
      INTO tender_status, opens, closes
      FROM "tender" WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."tender_id";
    -- Half-open, like the deadline itself: at `bid_closing_at` a bid is refused, and
    -- a PUBLISHED tender whose sweeper has not yet closed it refuses too.
    IF tender_status IS DISTINCT FROM 'PUBLISHED' OR opens IS NULL OR closes IS NULL
       OR clock_timestamp() < opens OR clock_timestamp() >= closes THEN
      RAISE EXCEPTION 'ck_bid_window: a bid is accepted only while the tender is PUBLISHED and inside [bid_opening_at, bid_closing_at)'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
