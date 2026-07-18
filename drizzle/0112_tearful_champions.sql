ALTER TABLE "providers" ADD COLUMN "upstream_billing_access_token" varchar;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "upstream_billing_user_id" varchar(128);