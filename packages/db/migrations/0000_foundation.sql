CREATE TABLE "auth_nonces" (
	"wallet" text PRIMARY KEY NOT NULL,
	"nonce" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_nonces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "indexer_cursor" (
	"program" text PRIMARY KEY NOT NULL,
	"signature" text NOT NULL,
	"slot" bigint NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "indexer_cursor" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "auth_nonces_deny_all" ON "auth_nonces" AS RESTRICTIVE FOR ALL TO "anon", "authenticated" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "indexer_cursor_deny_all" ON "indexer_cursor" AS RESTRICTIVE FOR ALL TO "anon", "authenticated" USING (false) WITH CHECK (false);