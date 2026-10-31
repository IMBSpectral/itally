-- Edit Log (audit trail): every change to vouchers, ledgers, groups and companies, recorded by
-- the database itself so no code path can skip it, and append-only so it can't be rewritten.
-- Indian companies must keep such a trail (Companies (Accounts) Rules, 2014, rule 3(1)).

CREATE TABLE edit_log (
  id          bigserial PRIMARY KEY,
  company_id  int NOT NULL,          -- deliberately no foreign key: the trail outlives what it records
  at          timestamptz NOT NULL DEFAULT now(),
  actor       text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('app.actor', true), ''), 'local user'),
  entity      text NOT NULL CHECK (entity IN ('voucher', 'ledger', 'group', 'company')),
  entity_id   int NOT NULL,
  action      text NOT NULL CHECK (action IN ('create', 'alter', 'cancel', 'delete')),
  label       text NOT NULL,         -- e.g. "Sales No. 12", a ledger's name
  data        jsonb NOT NULL         -- the state after the change; for a delete, what was deleted
);
CREATE INDEX edit_log_entity ON edit_log (company_id, entity, entity_id, id);
CREATE INDEX edit_log_time ON edit_log (company_id, at);

CREATE FUNCTION edit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'the edit log cannot be changed or deleted';
END $$;
CREATE TRIGGER edit_log_no_change BEFORE UPDATE OR DELETE ON edit_log
  FOR EACH ROW EXECUTE FUNCTION edit_log_append_only();
CREATE TRIGGER edit_log_no_truncate BEFORE TRUNCATE ON edit_log
  FOR EACH STATEMENT EXECUTE FUNCTION edit_log_append_only();

-- A voucher as it stands: header, entries (ledger by name and id) and bill-wise details.
CREATE FUNCTION voucher_snapshot(vid int) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'type', v.type, 'number', v.number, 'date', to_char(v.date, 'YYYY-MM-DD'),
    'narration', v.narration, 'cancelled', v.cancelled, 'version', v.version,
    'entries', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'ledgerId', e.ledger_id, 'ledger', l.name, 'amount', e.amount,
               'bills', (SELECT jsonb_agg(jsonb_build_object('type', a.ref_type, 'name', a.name,
                                  'dueDate', to_char(a.due_date, 'YYYY-MM-DD'), 'amount', a.amount) ORDER BY a.id)
                           FROM bill_allocations a WHERE a.entry_id = e.id)) ORDER BY e.line)
        FROM entries e JOIN ledgers l ON l.id = e.ledger_id WHERE e.voucher_id = v.id), '[]'::jsonb))
  FROM vouchers v WHERE v.id = vid
$$;

-- Created / altered / cancelled vouchers are logged at COMMIT, once their entries are in place.
CREATE FUNCTION log_voucher_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE snap jsonb;
BEGIN
  snap := voucher_snapshot(NEW.id);
  IF snap IS NULL THEN RETURN NULL; END IF;   -- deleted later in the same transaction
  INSERT INTO edit_log (company_id, entity, entity_id, action, label, data)
  VALUES (NEW.company_id, 'voucher', NEW.id,
          CASE WHEN TG_OP = 'INSERT' THEN 'create'
               WHEN NEW.cancelled AND NOT OLD.cancelled THEN 'cancel' ELSE 'alter' END,
          NEW.type || ' No. ' || NEW.number, snap);
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER vouchers_edit_log AFTER INSERT OR UPDATE ON vouchers
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION log_voucher_change();

-- A deleted voucher is logged as it was just before it went.
CREATE FUNCTION log_voucher_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO edit_log (company_id, entity, entity_id, action, label, data)
  VALUES (OLD.company_id, 'voucher', OLD.id, 'delete', OLD.type || ' No. ' || OLD.number,
          COALESCE(voucher_snapshot(OLD.id), to_jsonb(OLD)));
  RETURN OLD;
END $$;
CREATE TRIGGER vouchers_edit_log_delete BEFORE DELETE ON vouchers
  FOR EACH ROW EXECUTE FUNCTION log_voucher_delete();

-- Masters and companies: the row itself is the state.
CREATE FUNCTION log_master_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; kind text; cid int;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  kind := CASE TG_TABLE_NAME WHEN 'ledgers' THEN 'ledger' WHEN 'groups' THEN 'group' ELSE 'company' END;
  cid := CASE WHEN kind = 'company' THEN r.id ELSE (to_jsonb(r) ->> 'company_id')::int END;
  INSERT INTO edit_log (company_id, entity, entity_id, action, label, data)
  VALUES (cid, kind, r.id, CASE TG_OP WHEN 'INSERT' THEN 'create' WHEN 'UPDATE' THEN 'alter' ELSE 'delete' END,
          r.name, to_jsonb(r) - 'company_id');
  RETURN NULL;
END $$;
CREATE TRIGGER ledgers_edit_log AFTER INSERT OR UPDATE OR DELETE ON ledgers
  FOR EACH ROW EXECUTE FUNCTION log_master_change();
CREATE TRIGGER groups_edit_log AFTER INSERT OR UPDATE OR DELETE ON groups
  FOR EACH ROW EXECUTE FUNCTION log_master_change();
CREATE TRIGGER companies_edit_log AFTER INSERT OR UPDATE OR DELETE ON companies
  FOR EACH ROW EXECUTE FUNCTION log_master_change();
