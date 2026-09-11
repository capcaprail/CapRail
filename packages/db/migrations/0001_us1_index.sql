CREATE TYPE "public"."attempt_origin" AS ENUM('chain', 'simulation');--> statement-breakpoint
CREATE TYPE "public"."attempt_outcome" AS ENUM('allowed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."investor_status" AS ENUM('none', 'approved', 'revoked');--> statement-breakpoint
CREATE ROLE "caprail_api";--> statement-breakpoint
CREATE TABLE "companies" (
	"company_id" bigint PRIMARY KEY NOT NULL,
	"company" text NOT NULL,
	"admin" text NOT NULL,
	"compliance_officer" text NOT NULL,
	"name" text NOT NULL,
	"created_signature" text NOT NULL,
	"created_slot" bigint NOT NULL,
	"roles_set_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "companies_company_unique" UNIQUE("company")
);
--> statement-breakpoint
ALTER TABLE "companies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "holdings" (
	"mint" text NOT NULL,
	"wallet" text NOT NULL,
	"company_id" bigint NOT NULL,
	"amount" numeric(20, 0) NOT NULL,
	"distributed" numeric(20, 0) DEFAULT 0 NOT NULL,
	"last_signature" text NOT NULL,
	"last_slot" bigint NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	CONSTRAINT "holdings_mint_wallet_pk" PRIMARY KEY("mint","wallet"),
	CONSTRAINT "holdings_amount_non_negative" CHECK ("holdings"."amount" >= 0)
);
--> statement-breakpoint
ALTER TABLE "holdings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "investor_status_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "investor_status_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"mint" text NOT NULL,
	"wallet" text NOT NULL,
	"company_id" bigint NOT NULL,
	"status" "investor_status" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"jurisdiction" text,
	"investor_type" smallint NOT NULL,
	"set_at" timestamp with time zone NOT NULL,
	"set_by" text NOT NULL,
	"tx_signature" text NOT NULL,
	"event_index" integer NOT NULL,
	"slot" bigint NOT NULL,
	"block_time" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "investor_status_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "investors" (
	"mint" text NOT NULL,
	"wallet" text NOT NULL,
	"company_id" bigint NOT NULL,
	"status" "investor_status" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"jurisdiction" text,
	"investor_type" smallint NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text NOT NULL,
	"tx_signature" text NOT NULL,
	"slot" bigint NOT NULL,
	CONSTRAINT "investors_mint_wallet_pk" PRIMARY KEY("mint","wallet"),
	CONSTRAINT "investors_jurisdiction_iso2" CHECK ("investors"."jurisdiction" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
ALTER TABLE "investors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "policy_versions" (
	"mint" text NOT NULL,
	"version" integer NOT NULL,
	"company_id" bigint NOT NULL,
	"require_accreditation" boolean NOT NULL,
	"require_rofr" boolean NOT NULL,
	"rofr_window_secs" integer NOT NULL,
	"set_at" timestamp with time zone,
	"tx_signature" text NOT NULL,
	"slot" bigint NOT NULL,
	"block_time" timestamp with time zone,
	CONSTRAINT "policy_versions_mint_version_pk" PRIMARY KEY("mint","version")
);
--> statement-breakpoint
ALTER TABLE "policy_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tokens" (
	"mint" text PRIMARY KEY NOT NULL,
	"company_id" bigint NOT NULL,
	"treasury" text NOT NULL,
	"name" text NOT NULL,
	"symbol" text NOT NULL,
	"decimals" smallint NOT NULL,
	"total_supply" numeric(20, 0) NOT NULL,
	"require_accreditation" boolean NOT NULL,
	"require_rofr" boolean NOT NULL,
	"rofr_window_secs" integer NOT NULL,
	"policy_version" integer NOT NULL,
	"created_signature" text NOT NULL,
	"created_slot" bigint NOT NULL,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "transfer_attempts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "transfer_attempts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"mint" text NOT NULL,
	"company_id" bigint NOT NULL,
	"source_owner" text,
	"dest_owner" text,
	"amount" numeric(20, 0),
	"outcome" "attempt_outcome" NOT NULL,
	"reason_code" text,
	"origin" "attempt_origin" NOT NULL,
	"from_treasury" boolean DEFAULT false NOT NULL,
	"policy_version" integer,
	"tx_signature" text,
	"event_index" integer DEFAULT 0 NOT NULL,
	"slot" bigint,
	"block_time" timestamp with time zone NOT NULL,
	"logs" text[] NOT NULL,
	"reported_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfer_attempts_reason_matches_outcome" CHECK (("transfer_attempts"."outcome" = 'allowed') = ("transfer_attempts"."reason_code" IS NULL)),
	CONSTRAINT "transfer_attempts_chain_has_signature" CHECK (("transfer_attempts"."origin" = 'chain') = ("transfer_attempts"."tx_signature" IS NOT NULL)),
	CONSTRAINT "transfer_attempts_logs_bounded" CHECK (cardinality("transfer_attempts"."logs") <= 20)
);
--> statement-breakpoint
ALTER TABLE "transfer_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_mint_tokens_mint_fk" FOREIGN KEY ("mint") REFERENCES "public"."tokens"("mint") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_company_id_companies_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investor_status_events" ADD CONSTRAINT "investor_status_events_mint_tokens_mint_fk" FOREIGN KEY ("mint") REFERENCES "public"."tokens"("mint") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investor_status_events" ADD CONSTRAINT "investor_status_events_company_id_companies_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investors" ADD CONSTRAINT "investors_mint_tokens_mint_fk" FOREIGN KEY ("mint") REFERENCES "public"."tokens"("mint") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investors" ADD CONSTRAINT "investors_company_id_companies_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_mint_tokens_mint_fk" FOREIGN KEY ("mint") REFERENCES "public"."tokens"("mint") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_company_id_companies_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_company_id_companies_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_attempts" ADD CONSTRAINT "transfer_attempts_mint_tokens_mint_fk" FOREIGN KEY ("mint") REFERENCES "public"."tokens"("mint") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_attempts" ADD CONSTRAINT "transfer_attempts_company_id_companies_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "companies_admin_idx" ON "companies" USING btree ("admin");--> statement-breakpoint
CREATE INDEX "companies_compliance_officer_idx" ON "companies" USING btree ("compliance_officer");--> statement-breakpoint
CREATE INDEX "holdings_company_id_idx" ON "holdings" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "investor_status_events_tx_idx" ON "investor_status_events" USING btree ("tx_signature","event_index");--> statement-breakpoint
CREATE INDEX "investor_status_events_wallet_idx" ON "investor_status_events" USING btree ("mint","wallet","set_at");--> statement-breakpoint
CREATE INDEX "investors_company_id_idx" ON "investors" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "investors_wallet_idx" ON "investors" USING btree ("wallet");--> statement-breakpoint
CREATE INDEX "tokens_company_id_idx" ON "tokens" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transfer_attempts_tx_idx" ON "transfer_attempts" USING btree ("tx_signature","event_index") WHERE "transfer_attempts"."tx_signature" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "transfer_attempts_journal_idx" ON "transfer_attempts" USING btree ("company_id","block_time","id");--> statement-breakpoint
CREATE INDEX "transfer_attempts_mint_idx" ON "transfer_attempts" USING btree ("mint","block_time");--> statement-breakpoint
CREATE POLICY "companies_deny_all" ON "companies" AS RESTRICTIVE FOR ALL TO "anon", "authenticated" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "companies_api_select" ON "companies" AS PERMISSIVE FOR SELECT TO "caprail_api" USING ("companies"."company_id" = nullif(current_setting('app.company_id', true), '')::bigint OR "companies"."admin" = nullif(current_setting('app.wallet', true), '') OR "companies"."compliance_officer" = nullif(current_setting('app.wallet', true), '') OR EXISTS (SELECT 1 FROM investors i WHERE i.company_id = "companies"."company_id" AND i.wallet = nullif(current_setting('app.wallet', true), '')));--> statement-breakpoint
CREATE POLICY "holdings_deny_all" ON "holdings" AS RESTRICTIVE FOR ALL TO "anon", "authenticated" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "holdings_api_select" ON "holdings" AS PERMISSIVE FOR SELECT TO "caprail_api" USING ("holdings"."company_id" = nullif(current_setting('app.company_id', true), '')::bigint OR "holdings"."wallet" = nullif(current_setting('app.wallet', true), ''));--> statement-breakpoint
CREATE POLICY "investor_status_events_deny_all" ON "investor_status_events" AS RESTRICTIVE FOR ALL TO "anon", "authenticated" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "investor_status_events_api_select" ON "investor_status_events" AS PERMISSIVE FOR SELECT TO "caprail_api" USING ("investor_status_events"."company_id" = nullif(current_setting('app.company_id', true), '')::bigint OR "investor_status_events"."wallet" = nullif(current_setting('app.wallet', true), ''));--> statement-breakpoint
CREATE POLICY "investors_deny_all" ON "investors" AS RESTRICTIVE FOR ALL TO "anon", "authenticated" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "investors_api_select" ON "investors" AS PERMISSIVE FOR SELECT TO "caprail_api" USING ("investors"."company_id" = nullif(current_setting('app.company_id', true), '')::bigint OR "investors"."wallet" = nullif(current_setting('app.wallet', true), ''));--> statement-breakpoint
CREATE POLICY "policy_versions_deny_all" ON "policy_versions" AS RESTRICTIVE FOR ALL TO "anon", "authenticated" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "policy_versions_api_select" ON "policy_versions" AS PERMISSIVE FOR SELECT TO "caprail_api" USING ("policy_versions"."company_id" = nullif(current_setting('app.company_id', true), '')::bigint OR "policy_versions"."company_id" IN (SELECT c.company_id FROM companies c));--> statement-breakpoint
CREATE POLICY "tokens_deny_all" ON "tokens" AS RESTRICTIVE FOR ALL TO "anon", "authenticated" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "tokens_api_select" ON "tokens" AS PERMISSIVE FOR SELECT TO "caprail_api" USING ("tokens"."company_id" = nullif(current_setting('app.company_id', true), '')::bigint OR "tokens"."company_id" IN (SELECT c.company_id FROM companies c));--> statement-breakpoint
CREATE POLICY "transfer_attempts_deny_all" ON "transfer_attempts" AS RESTRICTIVE FOR ALL TO "anon", "authenticated" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "transfer_attempts_api_select" ON "transfer_attempts" AS PERMISSIVE FOR SELECT TO "caprail_api" USING ("transfer_attempts"."company_id" = nullif(current_setting('app.company_id', true), '')::bigint OR "transfer_attempts"."source_owner" = nullif(current_setting('app.wallet', true), '') OR "transfer_attempts"."dest_owner" = nullif(current_setting('app.wallet', true), '') OR "transfer_attempts"."reported_by" = nullif(current_setting('app.wallet', true), ''));--> statement-breakpoint
CREATE POLICY "transfer_attempts_api_insert" ON "transfer_attempts" AS PERMISSIVE FOR INSERT TO "caprail_api" WITH CHECK ("transfer_attempts"."origin" = 'simulation' AND "transfer_attempts"."reported_by" = nullif(current_setting('app.wallet', true), ''));--> statement-breakpoint
-- Grants are outside drizzle-kit's model (the snapshot tracks tables, indexes, policies
-- and roles only), so they live here by hand. `caprail_api` is what `withTenant` switches
-- to with SET LOCAL ROLE: it reads the index and writes nothing but simulation reports.
-- `postgres` must be a member of it for SET ROLE to be allowed.
GRANT USAGE ON SCHEMA "public" TO "caprail_api";--> statement-breakpoint
GRANT SELECT ON "companies", "tokens", "policy_versions", "investors", "investor_status_events", "transfer_attempts", "holdings" TO "caprail_api";--> statement-breakpoint
GRANT INSERT ON "transfer_attempts" TO "caprail_api";--> statement-breakpoint
GRANT USAGE ON SEQUENCE "transfer_attempts_id_seq" TO "caprail_api";--> statement-breakpoint
GRANT "caprail_api" TO "postgres";
