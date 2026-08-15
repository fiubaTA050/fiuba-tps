CREATE TYPE "public"."invite_status" AS ENUM('unaccepted', 'accepted', 'waiting', 'creating_repo', 'importing_starter_code', 'completed', 'errored_creating_repo', 'errored_importing_starter_code');--> statement-breakpoint
CREATE TABLE "invite_statuses" (
	"id" serial PRIMARY KEY NOT NULL,
	"status" "invite_status" DEFAULT 'unaccepted' NOT NULL,
	"assignment_invitation_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invite_statuses" ADD CONSTRAINT "invite_statuses_assignment_invitation_id_assignment_invitations_id_fk" FOREIGN KEY ("assignment_invitation_id") REFERENCES "public"."assignment_invitations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_statuses" ADD CONSTRAINT "invite_statuses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "index_invite_statuses_on_user_id" ON "invite_statuses" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "index_invite_statuses_on_invitation_id_and_user_id" ON "invite_statuses" USING btree ("assignment_invitation_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "index_roster_entries_on_roster_id_and_user_id" ON "roster_entries" USING btree ("roster_id","user_id") WHERE "roster_entries"."user_id" is not null;