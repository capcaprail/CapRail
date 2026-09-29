CREATE TYPE "public"."offer_stale_reason" AS ENUM('account_missing', 'frozen', 'not_delegated', 'delegation_short', 'balance_short');--> statement-breakpoint
CREATE TYPE "public"."offer_status" AS ENUM('open', 'filled', 'cancelled');--> statement-breakpoint
CREATE TABLE "offers" (
	"offer" text PRIMARY KEY NOT NULL,
	"mint" text NOT NULL,
	"company_id" numeric(20, 0) NOT NULL,
	"seller" text NOT NULL,
	"offer_id" numeric(20, 0) NOT NULL,
	"amount" numeric(20, 0) NOT NULL,
	"remaining" numeric(20, 0) NOT NULL,
	"price_per_unit" numeric(20, 0) NOT NULL,
	"payment_mint" text NOT NULL,
	"rofr_until" timestamp with time zone,
	"status" "offer_status" NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_signature" text NOT NULL,
	"created_slot" bigint NOT NULL,
	"closed_at" timestamp with time zone,
	"delegation_revoked" boolean,
	"updated_at" timestamp with time zone NOT NULL,
	"touched_slot" bigint NOT NULL,
	"available" numeric(20, 0),
	"stale_reason" "offer_stale_reason",
	"checked_at" timestamp with time zone,
	"checked_slot" bigint,
	CONSTRAINT "offers_remaining_bounded" CHECK ("offers"."remaining" <= "offers"."amount"),
	CONSTRAINT "offers_filled_means_zero" CHECK (("offers"."status" = 'filled') = ("offers"."remaining" = 0)),
	CONSTRAINT "offers_executability_only_when_open" CHECK ("offers"."status" = 'open' OR ("offers"."available" IS NULL AND "offers"."stale_reason" IS NULL)),
	CONSTRAINT "offers_stale_means_short" CHECK ("offers"."available" IS NULL OR ("offers"."available" <= "offers"."remaining" AND ("offers"."stale_reason" IS NULL) = ("offers"."available" = "offers"."remaining")))
);
--> statement-breakpoint
ALTER TABLE "offers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "trades" (
	"tx_signature" text NOT NULL,
	"event_index" integer NOT NULL,
	"offer" text NOT NULL,
	"mint" text NOT NULL,
	"company_id" numeric(20, 0) NOT NULL,
	"seller" text NOT NULL,
	"buyer" text NOT NULL,
	"offer_id" numeric(20, 0) NOT NULL,
	"amount" numeric(20, 0) NOT NULL,
	"price_per_unit" numeric(20, 0) NOT NULL,
	"payment" numeric(20, 0) NOT NULL,
	"fee" numeric(20, 0) NOT NULL,
	"payment_mint" text NOT NULL,
	"remaining" numeric(20, 0) NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"slot" bigint NOT NULL,
	"block_time" timestamp with time zone NOT NULL,
	CONSTRAINT "trades_tx_signature_event_index_pk" PRIMARY KEY("tx_signature","event_index"),
	CONSTRAINT "trades_fee_within_payment" CHECK ("trades"."fee" <= "trades"."payment")
);
--> statement-breakpoint
ALTER TABLE "trades" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_mint_tokens_mint_fk" FOREIGN KEY ("mint") REFERENCES "public"."tokens"("mint") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_company_id_companies_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_offer_offers_offer_fk" FOREIGN KEY ("offer") REFERENCES "public"."offers"("offer") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_mint_tokens_mint_fk" FOREIGN KEY ("mint") REFERENCES "public"."tokens"("mint") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_company_id_companies_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "offers_seller_idx" ON "offers" USING btree ("seller","mint","offer_id");--> statement-breakpoint
CREATE INDEX "offers_mint_status_idx" ON "offers" USING btree ("mint","status");--> statement-breakpoint
CREATE INDEX "offers_company_id_idx" ON "offers" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "offers_open_checked_idx" ON "offers" USING btree ("checked_at") WHERE "offers"."status" = 'open';--> statement-breakpoint
CREATE INDEX "trades_mint_idx" ON "trades" USING btree ("mint","block_time");--> statement-breakpoint
CREATE INDEX "trades_company_id_idx" ON "trades" USING btree ("company_id","block_time");--> statement-breakpoint
CREATE INDEX "trades_offer_idx" ON "trades" USING btree ("offer");--> statement-breakpoint
CREATE INDEX "trades_buyer_idx" ON "trades" USING btree ("buyer");--> statement-breakpoint
CREATE INDEX "trades_seller_idx" ON "trades" USING btree ("seller");--> statement-breakpoint
CREATE POLICY "offers_deny_all" ON "offers" AS RESTRICTIVE FOR ALL TO "anon", "authenticated" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "offers_api_select" ON "offers" AS PERMISSIVE FOR SELECT TO "caprail_api" USING ("offers"."company_id" = nullif(current_setting('app.company_id', true), '')::numeric OR "offers"."seller" = nullif(current_setting('app.wallet', true), ''));--> statement-breakpoint
CREATE POLICY "trades_deny_all" ON "trades" AS RESTRICTIVE FOR ALL TO "anon", "authenticated" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "trades_api_select" ON "trades" AS PERMISSIVE FOR SELECT TO "caprail_api" USING ("trades"."company_id" = nullif(current_setting('app.company_id', true), '')::numeric OR "trades"."buyer" = nullif(current_setting('app.wallet', true), '') OR "trades"."seller" = nullif(current_setting('app.wallet', true), ''));--> statement-breakpoint
-- Grants by hand, as in 0001: drizzle-kit does not model them. The market index is read
-- through `withTenant` like the rest; the worker writes it as the owner.
GRANT SELECT ON "offers", "trades" TO "caprail_api";
