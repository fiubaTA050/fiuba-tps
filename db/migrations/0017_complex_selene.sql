CREATE TABLE "late_submission_justifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"submission_id" integer NOT NULL,
	"reason" text NOT NULL,
	"created_by_user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_by_user_id" integer,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "late_submission_justifications" ADD CONSTRAINT "late_submission_justifications_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "late_submission_justifications" ADD CONSTRAINT "late_submission_justifications_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "late_submission_justifications" ADD CONSTRAINT "late_submission_justifications_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "index_late_submission_justifications_on_active_submission" ON "late_submission_justifications" USING btree ("submission_id") WHERE "late_submission_justifications"."revoked_at" is null;