-- The two UNIQUE constraints go first: the composite foreign keys below
-- reference them, and drizzle-kit emits them last.
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_id_organization_id_key" UNIQUE("id","organization_id");
--> statement-breakpoint
ALTER TABLE "group_assignments" ADD CONSTRAINT "group_assignments_id_grouping_id_key" UNIQUE("id","grouping_id");
--> statement-breakpoint
CREATE TABLE "teaching_assistant_allocations" (
	"id" serial PRIMARY KEY NOT NULL,
	"teaching_assistant_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"assignment_id" integer,
	"roster_entry_id" integer,
	"group_assignment_id" integer,
	"grouping_id" integer,
	"group_id" integer,
	"created_by_user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teaching_assistant_allocations_one_target" CHECK (("teaching_assistant_allocations"."assignment_id" is not null and "teaching_assistant_allocations"."roster_entry_id" is not null
        and "teaching_assistant_allocations"."group_assignment_id" is null and "teaching_assistant_allocations"."grouping_id" is null and "teaching_assistant_allocations"."group_id" is null)
       or ("teaching_assistant_allocations"."assignment_id" is null and "teaching_assistant_allocations"."roster_entry_id" is null
        and "teaching_assistant_allocations"."group_assignment_id" is not null and "teaching_assistant_allocations"."grouping_id" is not null and "teaching_assistant_allocations"."group_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "teaching_assistants" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"created_by_user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teaching_assistants_id_organization_id_key" UNIQUE("id","organization_id")
);
--> statement-breakpoint
ALTER TABLE "teaching_assistant_allocations" ADD CONSTRAINT "teaching_assistant_allocations_roster_entry_id_roster_entries_id_fk" FOREIGN KEY ("roster_entry_id") REFERENCES "public"."roster_entries"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "teaching_assistant_allocations" ADD CONSTRAINT "teaching_assistant_allocations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "teaching_assistant_allocations" ADD CONSTRAINT "ta_allocations_teaching_assistant_fkey" FOREIGN KEY ("teaching_assistant_id","organization_id") REFERENCES "public"."teaching_assistants"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "teaching_assistant_allocations" ADD CONSTRAINT "ta_allocations_assignment_fkey" FOREIGN KEY ("assignment_id","organization_id") REFERENCES "public"."assignments"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "teaching_assistant_allocations" ADD CONSTRAINT "ta_allocations_group_assignment_fkey" FOREIGN KEY ("group_assignment_id","grouping_id") REFERENCES "public"."group_assignments"("id","grouping_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "teaching_assistant_allocations" ADD CONSTRAINT "ta_allocations_grouping_fkey" FOREIGN KEY ("grouping_id","organization_id") REFERENCES "public"."groupings"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "teaching_assistant_allocations" ADD CONSTRAINT "ta_allocations_group_fkey" FOREIGN KEY ("group_id","grouping_id") REFERENCES "public"."groups"("id","grouping_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "teaching_assistants" ADD CONSTRAINT "teaching_assistants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "teaching_assistants" ADD CONSTRAINT "teaching_assistants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "teaching_assistants" ADD CONSTRAINT "teaching_assistants_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "index_ta_allocations_on_ta_and_roster_entry" ON "teaching_assistant_allocations" USING btree ("teaching_assistant_id","assignment_id","roster_entry_id") WHERE "teaching_assistant_allocations"."assignment_id" is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX "index_ta_allocations_on_ta_and_group" ON "teaching_assistant_allocations" USING btree ("teaching_assistant_id","group_assignment_id","group_id") WHERE "teaching_assistant_allocations"."group_assignment_id" is not null;
--> statement-breakpoint
CREATE INDEX "index_ta_allocations_on_assignment_id" ON "teaching_assistant_allocations" USING btree ("assignment_id");
--> statement-breakpoint
CREATE INDEX "index_ta_allocations_on_group_assignment_id" ON "teaching_assistant_allocations" USING btree ("group_assignment_id");
--> statement-breakpoint
CREATE INDEX "index_ta_allocations_on_roster_entry_id" ON "teaching_assistant_allocations" USING btree ("roster_entry_id");
--> statement-breakpoint
CREATE INDEX "index_ta_allocations_on_group_id" ON "teaching_assistant_allocations" USING btree ("group_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "index_teaching_assistants_on_organization_id_and_user_id" ON "teaching_assistants" USING btree ("organization_id","user_id");
--> statement-breakpoint
CREATE INDEX "index_teaching_assistants_on_user_id" ON "teaching_assistants" USING btree ("user_id");
