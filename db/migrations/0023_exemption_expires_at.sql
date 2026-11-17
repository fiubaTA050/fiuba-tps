-- Hand-edited: drizzle-kit adds the column NOT NULL in one step, which fails on
-- the rows already there. Those had no end date; an active one now expires the
-- moment this runs, so its current submission joins the grading queue.
ALTER TABLE "submission_exemptions" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
UPDATE "submission_exemptions" SET "expires_at" = coalesce("revoked_at", now());--> statement-breakpoint
ALTER TABLE "submission_exemptions" ALTER COLUMN "expires_at" SET NOT NULL;
