-- Inventory: units, stock groups, godowns, stock items, and the item lines of invoices.
-- Quantities are bigint thousandths of a unit (like paise for money), so 2.5 kg is 2500.
-- Inventory lines carry + for stock coming in, - for stock going out; the amount has the
-- same sign as the quantity (or is zero for free goods).

CREATE TABLE units (
  id          serial PRIMARY KEY,
  company_id  int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  symbol      text NOT NULL,
  name        text NOT NULL DEFAULT '',
  decimals    int NOT NULL DEFAULT 0 CHECK (decimals BETWEEN 0 AND 3)
);
CREATE UNIQUE INDEX units_symbol ON units (company_id, lower(symbol));

CREATE TABLE stock_groups (
  id          serial PRIMARY KEY,
  company_id  int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        text NOT NULL,
  parent_id   int REFERENCES stock_groups(id) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX stock_groups_name ON stock_groups (company_id, lower(name));

CREATE TABLE godowns (
  id          serial PRIMARY KEY,
  company_id  int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        text NOT NULL,
  parent_id   int REFERENCES godowns(id) DEFERRABLE INITIALLY DEFERRED,
  is_default  boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX godowns_name ON godowns (company_id, lower(name));
-- every company has Tally's default location
INSERT INTO godowns (company_id, name, is_default) SELECT id, 'Main Location', true FROM companies;

CREATE TABLE stock_items (
  id                 serial PRIMARY KEY,
  company_id         int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name               text NOT NULL,
  group_id           int REFERENCES stock_groups(id) DEFERRABLE INITIALLY DEFERRED,   -- null = Primary
  unit_id            int NOT NULL REFERENCES units(id) DEFERRABLE INITIALLY DEFERRED,
  opening_qty        bigint NOT NULL DEFAULT 0,     -- thousandths
  opening_value      bigint NOT NULL DEFAULT 0,     -- paise
  opening_godown_id  int REFERENCES godowns(id) DEFERRABLE INITIALLY DEFERRED,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (opening_qty >= 0 AND opening_value >= 0)
);
CREATE UNIQUE INDEX stock_items_name ON stock_items (company_id, lower(name));

CREATE TABLE inventory_entries (
  id          bigserial PRIMARY KEY,
  voucher_id  int NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  line        int NOT NULL,
  item_id     int NOT NULL REFERENCES stock_items(id) DEFERRABLE INITIALLY DEFERRED,
  godown_id   int NOT NULL REFERENCES godowns(id) DEFERRABLE INITIALLY DEFERRED,
  qty         bigint NOT NULL CHECK (qty <> 0),
  rate        bigint NOT NULL CHECK (rate >= 0),   -- paise per unit
  amount      bigint NOT NULL,
  UNIQUE (voucher_id, line),
  CHECK (amount = 0 OR sign(amount) = sign(qty))
);
CREATE INDEX inventory_entries_item ON inventory_entries (item_id);

-- An inventory line must use its own company's item and godown.
CREATE FUNCTION inventory_same_company() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cid int;
BEGIN
  SELECT company_id INTO cid FROM vouchers WHERE id = NEW.voucher_id;
  IF cid IS DISTINCT FROM (SELECT company_id FROM stock_items WHERE id = NEW.item_id)
     OR cid IS DISTINCT FROM (SELECT company_id FROM godowns WHERE id = NEW.godown_id) THEN
    RAISE EXCEPTION 'stock item or godown belongs to another company';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_same_company BEFORE INSERT OR UPDATE ON inventory_entries
  FOR EACH ROW EXECUTE FUNCTION inventory_same_company();

-- The Edit Log now covers inventory masters and the item lines of vouchers.
ALTER TABLE edit_log DROP CONSTRAINT edit_log_entity_check;
ALTER TABLE edit_log ADD CONSTRAINT edit_log_entity_check
  CHECK (entity IN ('voucher', 'ledger', 'group', 'company', 'stock item', 'stock group', 'unit', 'godown'));

CREATE OR REPLACE FUNCTION log_master_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; kind text; cid int; j jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  j := to_jsonb(r);
  kind := CASE TG_TABLE_NAME WHEN 'ledgers' THEN 'ledger' WHEN 'groups' THEN 'group' WHEN 'stock_items' THEN 'stock item'
               WHEN 'stock_groups' THEN 'stock group' WHEN 'units' THEN 'unit' WHEN 'godowns' THEN 'godown' ELSE 'company' END;
  cid := CASE WHEN kind = 'company' THEN (j ->> 'id')::int ELSE (j ->> 'company_id')::int END;
  INSERT INTO edit_log (company_id, entity, entity_id, action, label, data)
  VALUES (cid, kind, (j ->> 'id')::int, CASE TG_OP WHEN 'INSERT' THEN 'create' WHEN 'UPDATE' THEN 'alter' ELSE 'delete' END,
          COALESCE(j ->> 'name', j ->> 'symbol'), j - 'company_id');
  RETURN NULL;
END $$;
CREATE TRIGGER stock_items_edit_log AFTER INSERT OR UPDATE OR DELETE ON stock_items FOR EACH ROW EXECUTE FUNCTION log_master_change();
CREATE TRIGGER stock_groups_edit_log AFTER INSERT OR UPDATE OR DELETE ON stock_groups FOR EACH ROW EXECUTE FUNCTION log_master_change();
CREATE TRIGGER units_edit_log AFTER INSERT OR UPDATE OR DELETE ON units FOR EACH ROW EXECUTE FUNCTION log_master_change();
CREATE TRIGGER godowns_edit_log AFTER INSERT OR UPDATE OR DELETE ON godowns FOR EACH ROW EXECUTE FUNCTION log_master_change();

CREATE OR REPLACE FUNCTION voucher_snapshot(vid int) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'type', v.type, 'number', v.number, 'date', to_char(v.date, 'YYYY-MM-DD'),
    'narration', v.narration, 'cancelled', v.cancelled, 'version', v.version,
    'entries', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'ledgerId', e.ledger_id, 'ledger', l.name, 'amount', e.amount,
               'bills', (SELECT jsonb_agg(jsonb_build_object('type', a.ref_type, 'name', a.name,
                                  'dueDate', to_char(a.due_date, 'YYYY-MM-DD'), 'amount', a.amount) ORDER BY a.id)
                           FROM bill_allocations a WHERE a.entry_id = e.id)) ORDER BY e.line)
        FROM entries e JOIN ledgers l ON l.id = e.ledger_id WHERE e.voucher_id = v.id), '[]'::jsonb),
    'inventory', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('item', s.name, 'godown', g.name, 'qty', i.qty, 'rate', i.rate, 'amount', i.amount) ORDER BY i.line)
        FROM inventory_entries i JOIN stock_items s ON s.id = i.item_id JOIN godowns g ON g.id = i.godown_id
       WHERE i.voucher_id = v.id), '[]'::jsonb))
  FROM vouchers v WHERE v.id = vid
$$;
