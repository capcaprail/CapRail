CREATE SEQUENCE "public"."offers_revision_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "revision" bigint DEFAULT nextval('offers_revision_seq') NOT NULL;--> statement-breakpoint
CREATE INDEX "offers_company_revision_idx" ON "offers" USING btree ("company_id","revision");--> statement-breakpoint
-- By hand: drizzle-kit does not model triggers. The panel's feed reads `offers` past
-- its last `revision`; a new value is taken on insert and on an update that changes
-- what the panel shows of the offer, the old one is kept otherwise — so the stale
-- sweep re-reading an unchanged account, or `touched_slot` bookkeeping on every
-- transfer of a seller, sends no event. An explicit `revision` in a write is ignored.
CREATE FUNCTION "public"."caprail_offers_revision"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR (NEW.status, NEW.remaining, NEW.available, NEW.stale_reason, NEW.closed_at, NEW.rofr_until)
      IS DISTINCT FROM (OLD.status, OLD.remaining, OLD.available, OLD.stale_reason, OLD.closed_at, OLD.rofr_until) THEN
    NEW.revision := nextval('offers_revision_seq');
  ELSE
    NEW.revision := OLD.revision;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."caprail_offers_revision"() FROM PUBLIC, "anon", "authenticated";--> statement-breakpoint
CREATE TRIGGER "offers_revision" BEFORE INSERT OR UPDATE ON "offers" FOR EACH ROW EXECUTE FUNCTION "public"."caprail_offers_revision"();
