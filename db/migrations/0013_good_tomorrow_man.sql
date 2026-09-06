CREATE TYPE "public"."grading_run_status" AS ENUM('leased', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "grading_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"submission_id" integer NOT NULL,
	"api_key_id" integer,
	"status" "grading_run_status" DEFAULT 'leased' NOT NULL,
	"leased_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"score" numeric,
	"output" text,
	"tests" jsonb
);
--> statement-breakpoint
ALTER TABLE "grading_runs" ADD CONSTRAINT "grading_runs_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_runs" ADD CONSTRAINT "grading_runs_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "index_grading_runs_on_submission_id" ON "grading_runs" USING btree ("submission_id");