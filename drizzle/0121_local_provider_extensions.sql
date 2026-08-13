ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "smart_dispatch_config" jsonb DEFAULT '{"enabled":true,"healthScoreEnabled":false,"windowMinutes":30,"minConfidentSample":20,"successRatePenaltyWeight":100,"enableTTFBScore":false,"ttfbPenaltyWeight":20,"ttfbMaxSlowRatio":2,"ttfbMinConfidentSample":10,"cooldownBaseMs":120000,"cooldownMaxMs":1800000,"ewmaAlpha":0.3}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "key_strategy" varchar(20) DEFAULT 'round_robin' NOT NULL;
--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "upstream_billing_type" varchar(20) DEFAULT 'auto' NOT NULL;
--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "upstream_billing_access_token" varchar;
--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "upstream_billing_refresh_token" varchar;
--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "upstream_billing_cookie" varchar;
--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "upstream_billing_user_id" varchar(128);
--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "upstream_billing_refresh_interval_minutes" integer DEFAULT 30 NOT NULL;
--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "upstream_billing_snapshot" jsonb DEFAULT 'null'::jsonb;
--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "upstream_billing_last_attempted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "provider_groups" ADD COLUMN IF NOT EXISTS "max_upstream_multiplier" numeric(10, 4);
--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "circuit_breaker_rolling_window_duration" integer DEFAULT 60000;
--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "circuit_breaker_minimum_samples" integer DEFAULT 20;
--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "circuit_breaker_failure_rate_threshold" numeric(5, 4) DEFAULT '0.4';
--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "circuit_breaker_consecutive_failure_threshold" integer DEFAULT 8;
--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "circuit_breaker_half_open_max_concurrency" integer DEFAULT 2;
--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "circuit_breaker_half_open_lease_duration" integer DEFAULT 120000;
--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "circuit_breaker_base_open_duration" integer DEFAULT 60000;
--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "is_pinned" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_api_keys" (
  "id" serial PRIMARY KEY NOT NULL,
  "provider_id" integer NOT NULL,
  "key" varchar NOT NULL,
  "label" varchar(100),
  "is_enabled" boolean DEFAULT true NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
DECLARE
  missing_columns text;
BEGIN
  SELECT string_agg(required.column_name, ', ' ORDER BY required.column_name)
  INTO missing_columns
  FROM (VALUES
    ('id'), ('provider_id'), ('key'), ('label'), ('is_enabled'), ('sort_order'),
    ('created_at'), ('updated_at')
  ) AS required(column_name)
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.columns actual
    WHERE actual.table_schema = 'public'
      AND actual.table_name = 'provider_api_keys'
      AND actual.column_name = required.column_name
  );

  IF missing_columns IS NOT NULL THEN
    RAISE EXCEPTION 'provider_api_keys 表结构不完整，缺少列: %', missing_columns;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'provider_api_keys_provider_id_providers_id_fk'
      AND conrelid = 'public.provider_api_keys'::regclass
  ) THEN
    ALTER TABLE "provider_api_keys"
      ADD CONSTRAINT "provider_api_keys_provider_id_providers_id_fk"
      FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_provider_api_keys_provider_key" ON "provider_api_keys" USING btree ("provider_id", "key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_provider_api_keys_selection" ON "provider_api_keys" USING btree ("provider_id", "is_enabled", "sort_order", "id");
--> statement-breakpoint
INSERT INTO "provider_api_keys" ("provider_id", "key", "label", "is_enabled", "sort_order")
SELECT p."id", p."key", 'legacy', true, 0
FROM "providers" p
WHERE p."key" IS NOT NULL
ON CONFLICT DO NOTHING;
