ALTER TABLE "assignment_invitations" ADD COLUMN "short_key" varchar(255);--> statement-breakpoint
ALTER TABLE "group_assignment_invitations" ADD COLUMN "short_key" varchar(255);--> statement-breakpoint
CREATE UNIQUE INDEX "index_assignment_invitations_on_short_key" ON "assignment_invitations" USING btree ("short_key");--> statement-breakpoint
CREATE UNIQUE INDEX "index_group_assignment_invitations_on_short_key" ON "group_assignment_invitations" USING btree ("short_key");