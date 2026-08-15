CREATE TABLE "assignment_repos" (
	"id" serial PRIMARY KEY NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"assignment_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assignment_repos" ADD CONSTRAINT "assignment_repos_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_repos" ADD CONSTRAINT "assignment_repos_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "index_assignment_repos_on_assignment_id" ON "assignment_repos" USING btree ("assignment_id");--> statement-breakpoint
CREATE INDEX "index_assignment_repos_on_user_id" ON "assignment_repos" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "index_assignment_repos_on_github_repo_id" ON "assignment_repos" USING btree ("github_repo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "index_assignment_repos_on_assignment_id_and_user_id" ON "assignment_repos" USING btree ("assignment_id","user_id");