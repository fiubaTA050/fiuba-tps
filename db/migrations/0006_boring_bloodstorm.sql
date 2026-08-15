CREATE TABLE "group_assignment_invitations" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" varchar(255) NOT NULL,
	"group_assignment_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "group_assignment_repos" (
	"id" serial PRIMARY KEY NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"group_assignment_id" integer NOT NULL,
	"group_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_repo" boolean DEFAULT true NOT NULL,
	"title" varchar(255) NOT NULL,
	"organization_id" integer NOT NULL,
	"grouping_id" integer NOT NULL,
	"creator_id" integer NOT NULL,
	"slug" varchar(255) NOT NULL,
	"starter_code_repo_id" bigint,
	"max_members" integer,
	"max_teams" integer,
	"students_are_repo_admins" boolean DEFAULT false NOT NULL,
	"invitations_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "group_invite_statuses" (
	"id" serial PRIMARY KEY NOT NULL,
	"status" "invite_status" DEFAULT 'unaccepted' NOT NULL,
	"group_assignment_invitation_id" integer NOT NULL,
	"group_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "groupings" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"title" varchar(255) NOT NULL,
	"slug" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "groupings_id_organization_id_key" UNIQUE("id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"grouping_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"title" varchar(255) NOT NULL,
	"slug" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "groups_id_grouping_id_key" UNIQUE("id","grouping_id")
);
--> statement-breakpoint
CREATE TABLE "groups_users" (
	"group_id" integer NOT NULL,
	"grouping_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "groups_users_group_id_user_id_pk" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "group_assignment_invitations" ADD CONSTRAINT "group_assignment_invitations_group_assignment_id_group_assignments_id_fk" FOREIGN KEY ("group_assignment_id") REFERENCES "public"."group_assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_assignment_repos" ADD CONSTRAINT "group_assignment_repos_group_assignment_id_group_assignments_id_fk" FOREIGN KEY ("group_assignment_id") REFERENCES "public"."group_assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_assignment_repos" ADD CONSTRAINT "group_assignment_repos_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_assignments" ADD CONSTRAINT "group_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_assignments" ADD CONSTRAINT "group_assignments_grouping_id_groupings_id_fk" FOREIGN KEY ("grouping_id") REFERENCES "public"."groupings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_assignments" ADD CONSTRAINT "group_assignments_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_invite_statuses" ADD CONSTRAINT "group_invite_statuses_group_assignment_invitation_id_group_assignment_invitations_id_fk" FOREIGN KEY ("group_assignment_invitation_id") REFERENCES "public"."group_assignment_invitations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_invite_statuses" ADD CONSTRAINT "group_invite_statuses_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groupings" ADD CONSTRAINT "groupings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_grouping_id_organization_id_fkey" FOREIGN KEY ("grouping_id","organization_id") REFERENCES "public"."groupings"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups_users" ADD CONSTRAINT "groups_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups_users" ADD CONSTRAINT "groups_users_group_id_grouping_id_fkey" FOREIGN KEY ("group_id","grouping_id") REFERENCES "public"."groups"("id","grouping_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "index_group_assignment_invitations_on_group_assignment_id" ON "group_assignment_invitations" USING btree ("group_assignment_id");--> statement-breakpoint
CREATE INDEX "index_group_assignment_invitations_on_deleted_at" ON "group_assignment_invitations" USING btree ("deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "index_group_assignment_invitations_on_key" ON "group_assignment_invitations" USING btree ("key");--> statement-breakpoint
CREATE INDEX "index_group_assignment_repos_on_group_assignment_id" ON "group_assignment_repos" USING btree ("group_assignment_id");--> statement-breakpoint
CREATE INDEX "index_group_assignment_repos_on_group_id" ON "group_assignment_repos" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "index_group_assignment_repos_on_github_repo_id" ON "group_assignment_repos" USING btree ("github_repo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "index_group_assignment_repos_on_assignment_id_and_group_id" ON "group_assignment_repos" USING btree ("group_assignment_id","group_id");--> statement-breakpoint
CREATE INDEX "index_group_assignments_on_organization_id" ON "group_assignments" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "index_group_assignments_on_grouping_id" ON "group_assignments" USING btree ("grouping_id");--> statement-breakpoint
CREATE INDEX "index_group_assignments_on_deleted_at" ON "group_assignments" USING btree ("deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "index_group_assignments_on_organization_id_and_slug" ON "group_assignments" USING btree ("organization_id","slug") WHERE "group_assignments"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "index_group_assignments_on_organization_id_and_title" ON "group_assignments" USING btree ("organization_id","title") WHERE "group_assignments"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "index_group_invite_statuses_on_group_id" ON "group_invite_statuses" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "index_group_invite_statuses_on_invitation_id_and_group_id" ON "group_invite_statuses" USING btree ("group_assignment_invitation_id","group_id");--> statement-breakpoint
CREATE INDEX "index_groupings_on_organization_id" ON "groupings" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "index_groupings_on_organization_id_and_title" ON "groupings" USING btree ("organization_id","title");--> statement-breakpoint
CREATE UNIQUE INDEX "index_groupings_on_organization_id_and_slug" ON "groupings" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE INDEX "index_groups_on_grouping_id" ON "groups" USING btree ("grouping_id");--> statement-breakpoint
CREATE UNIQUE INDEX "index_groups_on_organization_id_and_slug" ON "groups" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE INDEX "index_groups_users_on_user_id" ON "groups_users" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "index_groups_users_on_grouping_id_and_user_id" ON "groups_users" USING btree ("grouping_id","user_id");