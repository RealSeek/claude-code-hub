ALTER TABLE "providers" ADD COLUMN "upstream_billing_refresh_interval_minutes" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "upstream_billing_snapshot" jsonb DEFAULT 'null'::jsonb;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "upstream_billing_last_attempted_at" timestamp with time zone;