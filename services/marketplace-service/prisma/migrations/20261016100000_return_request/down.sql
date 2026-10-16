-- Reverses 20261016100000_return_request.
--
-- Roll the code back BEFORE this runs: the previous code neither reads nor writes these tables.
-- This DESTROYS every return request, its lines and its history — they are the only record of what
-- a buyer asked to send back and what the supplier decided, and the events already published
-- (RETURN_REQUESTED, …) refer to them. Do it only on an environment where no real request exists.
SET LOCAL lock_timeout = '3s';

DROP TABLE IF EXISTS "return_status_history";
DROP TABLE IF EXISTS "return_line";
DROP TABLE IF EXISTS "return_request";

DROP FUNCTION IF EXISTS "return_status_history_guard"();
DROP FUNCTION IF EXISTS "return_line_guard"();
DROP FUNCTION IF EXISTS "return_request_history_check"();
DROP FUNCTION IF EXISTS "return_request_guard"();

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261016100000_return_request';
