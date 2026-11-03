ALTER TABLE "cats" ADD COLUMN "neutered_unconfirmed" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Move existing data forward: a cat called neutered with no neuter treatment, and no caretaker action that confirmed it, was
-- settled by neighbours alone, so it is unconfirmed until a caretaker says otherwise.
UPDATE "cats" c SET "neutered_unconfirmed" = true
WHERE c."status" = 'neutered'
  AND NOT EXISTS (SELECT 1 FROM "treatments" t WHERE t."cat_id" = c."id" AND t."type" = 'neuter')
  AND NOT EXISTS (
    SELECT 1 FROM "agent_actions" a
    WHERE a."action" = 'cat_updated'
      AND a."inputs"->>'catId' = c."id"::text
      AND a."inputs"->>'change' IN ('already_neutered', 'ear_tip_only')
  );
