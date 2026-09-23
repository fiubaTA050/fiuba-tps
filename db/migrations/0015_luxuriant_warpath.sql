CREATE TABLE "submission_exemptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"checkpoint_id" integer NOT NULL,
	"assignment_repo_id" integer NOT NULL,
	"created_by_user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "submission_exemptions" ADD CONSTRAINT "submission_exemptions_checkpoint_id_checkpoints_id_fk" FOREIGN KEY ("checkpoint_id") REFERENCES "public"."checkpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_exemptions" ADD CONSTRAINT "submission_exemptions_assignment_repo_id_assignment_repos_id_fk" FOREIGN KEY ("assignment_repo_id") REFERENCES "public"."assignment_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_exemptions" ADD CONSTRAINT "submission_exemptions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "index_submission_exemptions_on_checkpoint_and_repo" ON "submission_exemptions" USING btree ("checkpoint_id","assignment_repo_id");