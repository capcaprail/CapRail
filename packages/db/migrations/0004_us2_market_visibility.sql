-- By hand, before the policy that calls it: drizzle-kit does not model functions.
-- The hook's admission check (`caprail-hook` execute, check 2) over the index: a policy
-- without accreditation admits any wallet; otherwise the record must be 'approved' and
-- expire strictly after `p_at`. SECURITY DEFINER because the viewer may not see the
-- `tokens`/`investors` rows the answer depends on (a stranger to a company whose policy
-- admits anyone), and it runs as the owner, which RLS does not touch — so the policy on
-- `offers` that calls it cannot recurse. It answers only a boolean about the caller's
-- own wallet as the API passes it. Supabase grants EXECUTE on new functions to its HTTP
-- roles by default; revoked, so it is not an RPC that probes anyone's admission.
CREATE FUNCTION "public"."caprail_admits"("p_mint" text, "p_wallet" text, "p_at" timestamp with time zone)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p_wallet IS NOT NULL AND EXISTS (
    SELECT 1 FROM tokens t
    WHERE t.mint = p_mint
      AND (NOT t.require_accreditation OR EXISTS (
        SELECT 1 FROM investors i
        WHERE i.mint = t.mint AND i.wallet = p_wallet
          AND i.status = 'approved' AND i.expires_at > p_at))
  )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."caprail_admits"(text, text, timestamp with time zone) FROM PUBLIC, "anon", "authenticated";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."caprail_admits"(text, text, timestamp with time zone) TO "caprail_api";--> statement-breakpoint
CREATE POLICY "offers_market_select" ON "offers" AS PERMISSIVE FOR SELECT TO "caprail_api" USING ("offers"."status" = 'open' AND caprail_admits("offers"."mint", nullif(current_setting('app.wallet', true), ''), now()));--> statement-breakpoint
ALTER POLICY "companies_api_select" ON "companies" TO caprail_api USING ("companies"."company_id" = nullif(current_setting('app.company_id', true), '')::numeric OR "companies"."admin" = nullif(current_setting('app.wallet', true), '') OR "companies"."compliance_officer" = nullif(current_setting('app.wallet', true), '') OR EXISTS (SELECT 1 FROM investors i WHERE i.company_id = "companies"."company_id" AND i.wallet = nullif(current_setting('app.wallet', true), '')) OR EXISTS (SELECT 1 FROM holdings h WHERE h.company_id = "companies"."company_id" AND h.wallet = nullif(current_setting('app.wallet', true), '') AND h.amount > 0) OR EXISTS (SELECT 1 FROM offers o WHERE o.company_id = "companies"."company_id"));
