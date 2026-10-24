-- Mail the engine couldn't read was stored without a tab, which the Apple app can't decode, and the first spam verdicts
-- flagged newsletters that link through tracking domains. Both are put right, logged so clients pick them up.
WITH fixed AS (
	UPDATE "message" SET
		"category" = CASE WHEN "category" IN ('primary', 'promotions', 'social', 'updates', 'newsletters') THEN "category" ELSE 'primary' END,
		"spam" = false
	WHERE "spam" OR "category" NOT IN ('primary', 'promotions', 'social', 'updates', 'newsletters')
	RETURNING "id", "account_id"
), numbered AS (
	SELECT "id", "account_id", row_number() OVER (PARTITION BY "account_id" ORDER BY "id") AS n FROM fixed
), bumped AS (
	UPDATE "mail_account" a SET "version" = a."version" + c.cnt
	FROM (SELECT "account_id", count(*) AS cnt FROM fixed GROUP BY "account_id") c
	WHERE a."id" = c."account_id"
	RETURNING a."id", a."version", c.cnt
)
INSERT INTO "change_log" ("account_id", "version", "entity", "entity_id", "op")
SELECT n."account_id", b."version" - b.cnt + n.n, 'message', n."id", 'upsert' FROM numbered n JOIN bumped b ON b."id" = n."account_id";
