CREATE TABLE "teaching_assistant_repo_accesses" (
	"id" serial PRIMARY KEY NOT NULL,
	"teaching_assistant_id" integer NOT NULL,
	"group_assignment_repo_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "teaching_assistant_repo_accesses" ADD CONSTRAINT "teaching_assistant_repo_accesses_teaching_assistant_id_teaching_assistants_id_fk" FOREIGN KEY ("teaching_assistant_id") REFERENCES "public"."teaching_assistants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teaching_assistant_repo_accesses" ADD CONSTRAINT "teaching_assistant_repo_accesses_group_assignment_repo_id_group_assignment_repos_id_fk" FOREIGN KEY ("group_assignment_repo_id") REFERENCES "public"."group_assignment_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "index_ta_repo_accesses_on_ta_and_group_repo" ON "teaching_assistant_repo_accesses" USING btree ("teaching_assistant_id","group_assignment_repo_id");--> statement-breakpoint
CREATE INDEX "index_ta_repo_accesses_on_group_assignment_repo_id" ON "teaching_assistant_repo_accesses" USING btree ("group_assignment_repo_id");