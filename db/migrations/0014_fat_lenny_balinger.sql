ALTER TABLE "checkpoints" ADD COLUMN "autograder_id" varchar(255);--> statement-breakpoint
ALTER TABLE "checkpoints" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "assignments" DROP COLUMN "autograder_id";--> statement-breakpoint
ALTER TABLE "group_assignments" DROP COLUMN "autograder_id";