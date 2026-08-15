CREATE TABLE "roster_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"identifier" varchar(255) NOT NULL,
	"roster_id" integer NOT NULL,
	"user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rosters" (
	"id" serial PRIMARY KEY NOT NULL,
	"identifier_name" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "roster_id" integer;--> statement-breakpoint
ALTER TABLE "roster_entries" ADD CONSTRAINT "roster_entries_roster_id_rosters_id_fk" FOREIGN KEY ("roster_id") REFERENCES "public"."rosters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_entries" ADD CONSTRAINT "roster_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "index_roster_entries_on_roster_id" ON "roster_entries" USING btree ("roster_id");--> statement-breakpoint
CREATE INDEX "index_roster_entries_on_user_id" ON "roster_entries" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "index_roster_entries_on_roster_id_and_identifier" ON "roster_entries" USING btree ("roster_id","identifier");--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_roster_id_rosters_id_fk" FOREIGN KEY ("roster_id") REFERENCES "public"."rosters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "index_organizations_on_roster_id" ON "organizations" USING btree ("roster_id");