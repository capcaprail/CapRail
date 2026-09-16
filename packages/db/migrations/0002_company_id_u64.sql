-- `company_id` is a u64 on chain; int8 stops at 2^63 - 1, and the first devnet company
-- above that (T032) did not fit. Same type as the amounts: numeric(20, 0).
--
-- Order, by hand (drizzle-kit emitted ALTER COLUMN first and ALTER POLICY after): a
-- column used in a policy or a foreign key cannot change type underneath them, and
-- ALTER POLICY does not release it — so the select policies are dropped, the keys
-- dropped, the columns altered, the keys put back, the policies created again with
-- the `::numeric` cast. The insert policy on `transfer_attempts` does not name the
-- column and stays.
DROP POLICY "companies_api_select" ON "companies";--> statement-breakpoint
DROP POLICY "holdings_api_select" ON "holdings";--> statement-breakpoint
DROP POLICY "investor_status_events_api_select" ON "investor_status_events";--> statement-breakpoint
DROP POLICY "investors_api_select" ON "investors";--> statement-breakpoint
DROP POLICY "policy_versions_api_select" ON "policy_versions";--> statement-breakpoint
DROP POLICY "tokens_api_select" ON "tokens";--> statement-breakpoint
DROP POLICY "transfer_attempts_api_select" ON "transfer_attempts";--> statement-breakpoint
ALTER TABLE "holdings" DROP CONSTRAINT "holdings_company_id_companies_company_id_fk";--> statement-breakpoint
ALTER TABLE "investor_status_events" DROP CONSTRAINT "investor_status_events_company_id_companies_company_id_fk";--> statement-breakpoint
ALTER TABLE "investors" DROP CONSTRAINT "investors_company_id_companies_company_id_fk";--> statement-breakpoint
ALTER TABLE "policy_versions" DROP CONSTRAINT "policy_versions_company_id_companies_company_id_fk";--> statement-breakpoint
ALTER TABLE "tokens" DROP CONSTRAINT "tokens_company_id_companies_company_id_fk";--> statement-breakpoint
ALTER TABLE "transfer_attempts" DROP CONSTRAINT "transfer_attempts_company_id_companies_company_id_fk";--> statement-breakpoint
ALTER TABLE "companies" ALTER COLUMN "company_id" SET DATA TYPE numeric(20, 0);--> statement-breakpoint
ALTER TABLE "holdings" ALTER COLUMN "company_id" SET DATA TYPE numeric(20, 0);--> statement-breakpoint
ALTER TABLE "investor_status_events" ALTER COLUMN "company_id" SET DATA TYPE numeric(20, 0);--> statement-breakpoint
ALTER TABLE "investors" ALTER COLUMN "company_id" SET DATA TYPE numeric(20, 0);--> statement-breakpoint
ALTER TABLE "policy_versions" ALTER COLUMN "company_id" SET DATA TYPE numeric(20, 0);--> statement-breakpoint
ALTER TABLE "tokens" ALTER COLUMN "company_id" SET DATA TYPE numeric(20, 0);--> statement-breakpoint
ALTER TABLE "transfer_attempts" ALTER COLUMN "company_id" SET DATA TYPE numeric(20, 0);--> statement-breakpoint
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_company_id_companies_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investor_status_events" ADD CONSTRAINT "investor_status_events_company_id_companies_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investors" ADD CONSTRAINT "investors_company_id_companies_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_company_id_companies_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_company_id_companies_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_attempts" ADD CONSTRAINT "transfer_attempts_company_id_companies_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "companies_api_select" ON "companies" AS PERMISSIVE FOR SELECT TO "caprail_api" USING ("companies"."company_id" = nullif(current_setting('app.company_id', true), '')::numeric OR "companies"."admin" = nullif(current_setting('app.wallet', true), '') OR "companies"."compliance_officer" = nullif(current_setting('app.wallet', true), '') OR EXISTS (SELECT 1 FROM investors i WHERE i.company_id = "companies"."company_id" AND i.wallet = nullif(current_setting('app.wallet', true), '')));--> statement-breakpoint
CREATE POLICY "holdings_api_select" ON "holdings" AS PERMISSIVE FOR SELECT TO "caprail_api" USING ("holdings"."company_id" = nullif(current_setting('app.company_id', true), '')::numeric OR "holdings"."wallet" = nullif(current_setting('app.wallet', true), ''));--> statement-breakpoint
CREATE POLICY "investor_status_events_api_select" ON "investor_status_events" AS PERMISSIVE FOR SELECT TO "caprail_api" USING ("investor_status_events"."company_id" = nullif(current_setting('app.company_id', true), '')::numeric OR "investor_status_events"."wallet" = nullif(current_setting('app.wallet', true), ''));--> statement-breakpoint
CREATE POLICY "investors_api_select" ON "investors" AS PERMISSIVE FOR SELECT TO "caprail_api" USING ("investors"."company_id" = nullif(current_setting('app.company_id', true), '')::numeric OR "investors"."wallet" = nullif(current_setting('app.wallet', true), ''));--> statement-breakpoint
CREATE POLICY "policy_versions_api_select" ON "policy_versions" AS PERMISSIVE FOR SELECT TO "caprail_api" USING ("policy_versions"."company_id" = nullif(current_setting('app.company_id', true), '')::numeric OR "policy_versions"."company_id" IN (SELECT c.company_id FROM companies c));--> statement-breakpoint
CREATE POLICY "tokens_api_select" ON "tokens" AS PERMISSIVE FOR SELECT TO "caprail_api" USING ("tokens"."company_id" = nullif(current_setting('app.company_id', true), '')::numeric OR "tokens"."company_id" IN (SELECT c.company_id FROM companies c));--> statement-breakpoint
CREATE POLICY "transfer_attempts_api_select" ON "transfer_attempts" AS PERMISSIVE FOR SELECT TO "caprail_api" USING ("transfer_attempts"."company_id" = nullif(current_setting('app.company_id', true), '')::numeric OR "transfer_attempts"."source_owner" = nullif(current_setting('app.wallet', true), '') OR "transfer_attempts"."dest_owner" = nullif(current_setting('app.wallet', true), '') OR "transfer_attempts"."reported_by" = nullif(current_setting('app.wallet', true), ''));
