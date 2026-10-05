CREATE TABLE "submission_feedbacks" (
	"id" serial PRIMARY KEY NOT NULL,
	"submission_id" integer NOT NULL,
	"body" text,
	"replaces_id" integer,
	"created_by_user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "submission_feedbacks" ADD CONSTRAINT "submission_feedbacks_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_feedbacks" ADD CONSTRAINT "submission_feedbacks_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_feedbacks" ADD CONSTRAINT "submission_feedbacks_replaces_id_fk" FOREIGN KEY ("replaces_id") REFERENCES "public"."submission_feedbacks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "index_submission_feedbacks_on_submission_id" ON "submission_feedbacks" USING btree ("submission_id","id" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "index_submission_feedbacks_on_replaces_id" ON "submission_feedbacks" USING btree ("replaces_id");--> statement-breakpoint
CREATE UNIQUE INDEX "index_submission_feedbacks_on_first_version" ON "submission_feedbacks" USING btree ("submission_id") WHERE "submission_feedbacks"."replaces_id" is null;