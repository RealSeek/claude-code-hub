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
ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "key_strategy" varchar(20) DEFAULT 'round_robin' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'provider_api_keys_provider_id_providers_id_fk'
  ) THEN
    ALTER TABLE "provider_api_keys"
      ADD CONSTRAINT "provider_api_keys_provider_id_providers_id_fk"
      FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_provider_api_keys_provider_key" ON "provider_api_keys" USING btree ("provider_id","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_provider_api_keys_selection" ON "provider_api_keys" USING btree ("provider_id","is_enabled","sort_order","id");--> statement-breakpoint
INSERT INTO "provider_api_keys" ("provider_id", "key", "label", "is_enabled", "sort_order")
SELECT p."id", p."key", 'legacy', true, 0
FROM "providers" p
WHERE p."key" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "provider_api_keys" k
    WHERE k."provider_id" = p."id"
  );
