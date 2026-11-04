-- Before reports, a photo guess could set cats.flags, which now means facts a person confirmed. A hurt, pregnant or sick
-- flag on a cat that has no report for that claim is filed as an open photo report (no reporter, no photo) and the flag
-- is taken off, so a caretaker checks it once. Neutered cats keep their history.
WITH "filed" AS (
	INSERT INTO "reports" ("cat_id", "claim", "source", "status", "reported_on")
	SELECT "c"."id", "f"."claim", 'photo', 'open', (now() AT TIME ZONE 'Asia/Manila')::date
	FROM "cats" "c" CROSS JOIN LATERAL unnest("c"."flags") AS "f"("claim")
	WHERE "f"."claim" IN ('injured', 'pregnant', 'sick')
		AND "c"."status" <> 'neutered'
		AND NOT EXISTS (SELECT 1 FROM "reports" "r" WHERE "r"."cat_id" = "c"."id" AND "r"."claim" = "f"."claim")
	RETURNING "cat_id", "claim"
)
UPDATE "cats" SET "flags" = COALESCE(
	(SELECT array_agg("x"."flag" ORDER BY "x"."n") FROM unnest("cats"."flags") WITH ORDINALITY AS "x"("flag", "n")
		WHERE NOT EXISTS (SELECT 1 FROM "filed" WHERE "filed"."cat_id" = "cats"."id" AND "filed"."claim" = "x"."flag")),
	'{}'::text[]
)
WHERE "id" IN (SELECT "cat_id" FROM "filed");
