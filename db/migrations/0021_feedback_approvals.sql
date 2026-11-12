CREATE TABLE "submission_feedback_approvals" (
	"id" serial PRIMARY KEY NOT NULL,
	"feedback_id" integer NOT NULL,
	"approved_by_user_id" integer NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "submission_feedbacks" ADD COLUMN "needs_approval" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "submission_feedback_approvals" ADD CONSTRAINT "submission_feedback_approvals_feedback_id_submission_feedbacks_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."submission_feedbacks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_feedback_approvals" ADD CONSTRAINT "submission_feedback_approvals_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "index_submission_feedback_approvals_on_feedback_id" ON "submission_feedback_approvals" USING btree ("feedback_id");