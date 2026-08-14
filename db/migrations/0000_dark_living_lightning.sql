CREATE TABLE "organizations" (
	"id" serial PRIMARY KEY NOT NULL,
	"github_id" bigint NOT NULL,
	"title" varchar(255) NOT NULL,
	"slug" varchar(255) NOT NULL,
	"installation_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "organizations_users" (
	"user_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	CONSTRAINT "organizations_users_user_id_organization_id_pk" PRIMARY KEY("user_id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"uid" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"site_admin" boolean DEFAULT false NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"github_login" varchar(255),
	"github_name" varchar(255),
	"github_avatar_url" varchar(255),
	"github_html_url" varchar(255),
	"teacher" boolean,
	"student" boolean
);
--> statement-breakpoint
ALTER TABLE "organizations_users" ADD CONSTRAINT "organizations_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations_users" ADD CONSTRAINT "organizations_users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "index_organizations_on_github_id" ON "organizations" USING btree ("github_id");--> statement-breakpoint
CREATE INDEX "index_organizations_on_deleted_at" ON "organizations" USING btree ("deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "index_organizations_on_slug" ON "organizations" USING btree ("slug") WHERE "organizations"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "index_organizations_on_github_id_and_title" ON "organizations" USING btree ("github_id","title") WHERE "organizations"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "index_users_on_uid" ON "users" USING btree ("uid");