ALTER TABLE "checkpoints" ALTER COLUMN "assignment_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "submission_exemptions" ALTER COLUMN "assignment_repo_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "submissions" ALTER COLUMN "assignment_repo_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD COLUMN "group_assignment_id" integer;--> statement-breakpoint
ALTER TABLE "submission_exemptions" ADD COLUMN "group_assignment_repo_id" integer;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "group_assignment_repo_id" integer;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_group_assignment_id_group_assignments_id_fk" FOREIGN KEY ("group_assignment_id") REFERENCES "public"."group_assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_exemptions" ADD CONSTRAINT "submission_exemptions_group_assignment_repo_id_group_assignment_repos_id_fk" FOREIGN KEY ("group_assignment_repo_id") REFERENCES "public"."group_assignment_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_group_assignment_repo_id_group_assignment_repos_id_fk" FOREIGN KEY ("group_assignment_repo_id") REFERENCES "public"."group_assignment_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "index_checkpoints_on_group_assignment_id" ON "checkpoints" USING btree ("group_assignment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "index_checkpoints_on_group_assignment_id_and_title" ON "checkpoints" USING btree ("group_assignment_id","title");--> statement-breakpoint
CREATE UNIQUE INDEX "index_checkpoints_on_group_assignment_id_unnamed" ON "checkpoints" USING btree ("group_assignment_id") WHERE "checkpoints"."title" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "index_submission_exemptions_on_checkpoint_and_group_repo" ON "submission_exemptions" USING btree ("checkpoint_id","group_assignment_repo_id");--> statement-breakpoint
CREATE INDEX "index_submissions_on_group_repo_and_checkpoint" ON "submissions" USING btree ("group_assignment_repo_id","checkpoint_id","id" desc);--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_one_assignment" CHECK (num_nonnulls("checkpoints"."assignment_id", "checkpoints"."group_assignment_id") = 1);--> statement-breakpoint
ALTER TABLE "submission_exemptions" ADD CONSTRAINT "submission_exemptions_one_repo" CHECK (num_nonnulls("submission_exemptions"."assignment_repo_id", "submission_exemptions"."group_assignment_repo_id") = 1);--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_one_repo" CHECK (num_nonnulls("submissions"."assignment_repo_id", "submissions"."group_assignment_repo_id") = 1);