SELECT app.enable_tenant_rls('ledger_entries');
--> statement-breakpoint
-- Append-only, for every role.
REVOKE UPDATE, DELETE, TRUNCATE ON ledger_entries FROM app_user;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
-- Each journal must balance when the transaction commits.
CREATE OR REPLACE FUNCTION app.check_journal_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  difference bigint;
BEGIN
  SELECT coalesce(sum(debit_paise), 0) - coalesce(sum(credit_paise), 0) INTO difference
  FROM ledger_entries WHERE journal_id = NEW.journal_id;
  IF difference <> 0 THEN
    RAISE EXCEPTION 'journal % is not balanced (difference % paise)', NEW.journal_id, difference
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_journal_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_journal_balanced();
