CREATE TABLE "assignment_invitations" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" varchar(255) NOT NULL,
	"assignment_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_repo" boolean DEFAULT true NOT NULL,
	"title" varchar(255) NOT NULL,
	"organization_id" integer NOT NULL,
	"creator_id" integer NOT NULL,
	"slug" varchar(255) NOT NULL,
	"students_are_repo_admins" boolean DEFAULT false NOT NULL,
	"invitations_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "assignment_invitations" ADD CONSTRAINT "assignment_invitations_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "index_assignment_invitations_on_assignment_id" ON "assignment_invitations" USING btree ("assignment_id");--> statement-breakpoint
CREATE INDEX "index_assignment_invitations_on_deleted_at" ON "assignment_invitations" USING btree ("deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "index_assignment_invitations_on_key" ON "assignment_invitations" USING btree ("key");--> statement-breakpoint
CREATE INDEX "index_assignments_on_organization_id" ON "assignments" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "index_assignments_on_deleted_at" ON "assignments" USING btree ("deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "index_assignments_on_organization_id_and_slug" ON "assignments" USING btree ("organization_id","slug") WHERE "assignments"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "index_assignments_on_organization_id_and_title" ON "assignments" USING btree ("organization_id","title") WHERE "assignments"."deleted_at" is null;