CREATE TABLE "checkpoints" (
	"id" serial PRIMARY KEY NOT NULL,
	"assignment_id" integer NOT NULL,
	"title" varchar(60),
	"deadline_at" timestamp with time zone,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"assignment_repo_id" integer NOT NULL,
	"checkpoint_id" integer NOT NULL,
	"sha" varchar(40) NOT NULL,
	"ref" varchar(255) NOT NULL,
	"committed_at" timestamp with time zone NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_by_user_id" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_assignment_repo_id_assignment_repos_id_fk" FOREIGN KEY ("assignment_repo_id") REFERENCES "public"."assignment_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_checkpoint_id_checkpoints_id_fk" FOREIGN KEY ("checkpoint_id") REFERENCES "public"."checkpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "index_checkpoints_on_assignment_id" ON "checkpoints" USING btree ("assignment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "index_checkpoints_on_assignment_id_and_title" ON "checkpoints" USING btree ("assignment_id","title");--> statement-breakpoint
CREATE UNIQUE INDEX "index_checkpoints_on_assignment_id_unnamed" ON "checkpoints" USING btree ("assignment_id") WHERE "checkpoints"."title" is null;--> statement-breakpoint
CREATE INDEX "index_submissions_on_repo_and_checkpoint" ON "submissions" USING btree ("assignment_repo_id","checkpoint_id","id" desc);