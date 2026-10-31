-- Cost centres, as in Tally: cost categories (every company has "Primary Cost Category"), cost
-- centres in a tree under a category, a ledger switch "cost centres are applicable", and the
-- split of a ledger entry's amount across cost centres.

CREATE TABLE cost_categories (
  id          serial PRIMARY KEY,
  company_id  int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (btrim(name) <> ''),
  is_default  boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX cost_categories_name ON cost_categories (company_id, lower(name));
INSERT INTO cost_categories (company_id, name, is_default) SELECT id, 'Primary Cost Category', true FROM companies;

CREATE TABLE cost_centres (
  id           serial PRIMARY KEY,
  company_id   int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (btrim(name) <> ''),
  category_id  int NOT NULL REFERENCES cost_categories(id) DEFERRABLE INITIALLY DEFERRED,
  parent_id    int REFERENCES cost_centres(id) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX cost_centres_name ON cost_centres (company_id, lower(name));

ALTER TABLE ledgers ADD COLUMN cost_centres boolean NOT NULL DEFAULT false;

-- signed like the entry: the allocations of an entry add up to its amount
CREATE TABLE cost_allocations (
  id              bigserial PRIMARY KEY,
  entry_id        bigint NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  cost_centre_id  int NOT NULL REFERENCES cost_centres(id),
  amount          bigint NOT NULL CHECK (amount <> 0)
);
CREATE INDEX cost_allocations_entry ON cost_allocations (entry_id);
CREATE INDEX cost_allocations_centre ON cost_allocations (cost_centre_id);

-- An allocation must use its own company's cost centre.
CREATE FUNCTION cost_allocation_same_company() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT v.company_id FROM entries e JOIN vouchers v ON v.id = e.voucher_id WHERE e.id = NEW.entry_id)
     IS DISTINCT FROM (SELECT company_id FROM cost_centres WHERE id = NEW.cost_centre_id) THEN
    RAISE EXCEPTION 'cost centre % belongs to another company', NEW.cost_centre_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cost_allocation_same_company BEFORE INSERT OR UPDATE ON cost_allocations
  FOR EACH ROW EXECUTE FUNCTION cost_allocation_same_company();

-- The Edit Log covers the new masters.
ALTER TABLE edit_log DROP CONSTRAINT edit_log_entity_check;
ALTER TABLE edit_log ADD CONSTRAINT edit_log_entity_check
  CHECK (entity IN ('voucher', 'ledger', 'group', 'company', 'stock item', 'stock group', 'unit', 'godown', 'cost category', 'cost centre'));

CREATE OR REPLACE FUNCTION log_master_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; kind text; cid int; j jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  j := to_jsonb(r);
  kind := CASE TG_TABLE_NAME WHEN 'ledgers' THEN 'ledger' WHEN 'groups' THEN 'group' WHEN 'stock_items' THEN 'stock item'
               WHEN 'stock_groups' THEN 'stock group' WHEN 'units' THEN 'unit' WHEN 'godowns' THEN 'godown'
               WHEN 'cost_categories' THEN 'cost category' WHEN 'cost_centres' THEN 'cost centre' ELSE 'company' END;
  cid := CASE WHEN kind = 'company' THEN (j ->> 'id')::int ELSE (j ->> 'company_id')::int END;
  INSERT INTO edit_log (company_id, entity, entity_id, action, label, data)
  VALUES (cid, kind, (j ->> 'id')::int, CASE TG_OP WHEN 'INSERT' THEN 'create' WHEN 'UPDATE' THEN 'alter' ELSE 'delete' END,
          COALESCE(j ->> 'name', j ->> 'symbol'), j - 'company_id');
  RETURN NULL;
END $$;
CREATE TRIGGER cost_categories_edit_log AFTER INSERT OR UPDATE OR DELETE ON cost_categories FOR EACH ROW EXECUTE FUNCTION log_master_change();
CREATE TRIGGER cost_centres_edit_log AFTER INSERT OR UPDATE OR DELETE ON cost_centres FOR EACH ROW EXECUTE FUNCTION log_master_change();

-- A voucher's Edit Log picture now carries each entry's cost centre split.
CREATE OR REPLACE FUNCTION voucher_snapshot(vid int) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'type', v.type, 'number', v.number, 'date', to_char(v.date, 'YYYY-MM-DD'),
    'narration', v.narration, 'cancelled', v.cancelled, 'version', v.version,
    'party', (SELECT name FROM ledgers WHERE id = v.party_ledger_id),
    'entries', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'ledgerId', e.ledger_id, 'ledger', l.name, 'amount', e.amount,
               'bills', (SELECT jsonb_agg(jsonb_build_object('type', a.ref_type, 'name', a.name,
                                  'dueDate', to_char(a.due_date, 'YYYY-MM-DD'), 'amount', a.amount) ORDER BY a.id)
                           FROM bill_allocations a WHERE a.entry_id = e.id),
               'costs', (SELECT jsonb_agg(jsonb_build_object('centre', c.name, 'amount', ca.amount) ORDER BY ca.id)
                           FROM cost_allocations ca JOIN cost_centres c ON c.id = ca.cost_centre_id WHERE ca.entry_id = e.id)) ORDER BY e.line)
        FROM entries e JOIN ledgers l ON l.id = e.ledger_id WHERE e.voucher_id = v.id), '[]'::jsonb),
    'inventory', COALESCE((
      SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('item', s.name, 'godown', g.name, 'qty', i.qty, 'rate', i.rate, 'amount', i.amount,
               'counted', i.counted, 'dueDate', to_char(i.due_date, 'YYYY-MM-DD'),
               'order', (SELECT o.type || ' No. ' || o.number FROM vouchers o WHERE o.id = i.order_id),
               'tracking', (SELECT t.type || ' No. ' || t.number FROM vouchers t WHERE t.id = i.tracking_id))) ORDER BY i.line)
        FROM inventory_entries i JOIN stock_items s ON s.id = i.item_id JOIN godowns g ON g.id = i.godown_id
       WHERE i.voucher_id = v.id), '[]'::jsonb))
  FROM vouchers v WHERE v.id = vid
$$;

-- A batch's Edit Log the same way (013's rules and totals unchanged).
CREATE OR REPLACE FUNCTION close_voucher_batch(ids int[]) RETURNS void LANGUAGE plpgsql AS $$
DECLARE bad record;
BEGIN
  SELECT e.ledger_id INTO bad FROM entries e JOIN vouchers v ON v.id = e.voucher_id JOIN ledgers l ON l.id = e.ledger_id
   WHERE e.voucher_id = ANY(ids) AND l.company_id <> v.company_id LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'ledger % belongs to another company', bad.ledger_id; END IF;
  PERFORM 1 FROM inventory_entries i JOIN vouchers v ON v.id = i.voucher_id
     JOIN stock_items s ON s.id = i.item_id JOIN godowns g ON g.id = i.godown_id
   WHERE i.voucher_id = ANY(ids) AND (s.company_id <> v.company_id OR g.company_id <> v.company_id) LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'stock item or godown belongs to another company'; END IF;

  SELECT v.id, count(e.id) n, COALESCE(SUM(e.amount), 0) total INTO bad
    FROM vouchers v LEFT JOIN entries e ON e.voucher_id = v.id
   WHERE v.id = ANY(ids)
   GROUP BY v.id
  HAVING CASE WHEN v.cancelled OR v.type IN ('Sales Order', 'Purchase Order', 'Delivery Note', 'Receipt Note', 'Stock Journal', 'Physical Stock')
              THEN count(e.id) > 0
              ELSE count(e.id) < 2 OR COALESCE(SUM(e.amount), 0) <> 0 END
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'voucher % is not balanced (entries %, difference %)', bad.id, bad.n, bad.total
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO ledger_daily (ledger_id, day, dr, cr)
  SELECT e.ledger_id, v.date, SUM(GREATEST(e.amount, 0)), SUM(GREATEST(-e.amount, 0))
    FROM entries e JOIN vouchers v ON v.id = e.voucher_id
   WHERE e.voucher_id = ANY(ids)
   GROUP BY e.ledger_id, v.date
  ON CONFLICT (ledger_id, day) DO UPDATE
     SET dr = ledger_daily.dr + EXCLUDED.dr, cr = ledger_daily.cr + EXCLUDED.cr;

  INSERT INTO edit_log (company_id, entity, entity_id, action, label, data)
  SELECT v.company_id, 'voucher', v.id, 'create', v.type || ' No. ' || v.number,
         jsonb_build_object(
           'type', v.type, 'number', v.number, 'date', to_char(v.date, 'YYYY-MM-DD'),
           'narration', v.narration, 'cancelled', v.cancelled, 'version', v.version,
           'party', p.name,
           'entries', COALESCE(e.list, '[]'::jsonb),
           'inventory', COALESCE(i.list, '[]'::jsonb))
    FROM vouchers v
    LEFT JOIN ledgers p ON p.id = v.party_ledger_id
    LEFT JOIN (
      SELECT e.voucher_id, jsonb_agg(jsonb_build_object(
               'ledgerId', e.ledger_id, 'ledger', l.name, 'amount', e.amount, 'bills', b.list, 'costs', c.list) ORDER BY e.line) list
        FROM entries e JOIN ledgers l ON l.id = e.ledger_id
        LEFT JOIN (
          SELECT a.entry_id, jsonb_agg(jsonb_build_object('type', a.ref_type, 'name', a.name,
                   'dueDate', to_char(a.due_date, 'YYYY-MM-DD'), 'amount', a.amount) ORDER BY a.id) list
            FROM bill_allocations a JOIN entries x ON x.id = a.entry_id
           WHERE x.voucher_id = ANY(ids) GROUP BY a.entry_id) b ON b.entry_id = e.id
        LEFT JOIN (
          SELECT ca.entry_id, jsonb_agg(jsonb_build_object('centre', cc.name, 'amount', ca.amount) ORDER BY ca.id) list
            FROM cost_allocations ca JOIN cost_centres cc ON cc.id = ca.cost_centre_id JOIN entries x ON x.id = ca.entry_id
           WHERE x.voucher_id = ANY(ids) GROUP BY ca.entry_id) c ON c.entry_id = e.id
       WHERE e.voucher_id = ANY(ids) GROUP BY e.voucher_id) e ON e.voucher_id = v.id
    LEFT JOIN (
      SELECT i.voucher_id, jsonb_agg(jsonb_strip_nulls(jsonb_build_object('item', s.name, 'godown', g.name, 'qty', i.qty,
               'rate', i.rate, 'amount', i.amount, 'counted', i.counted, 'dueDate', to_char(i.due_date, 'YYYY-MM-DD'),
               'order', (SELECT o.type || ' No. ' || o.number FROM vouchers o WHERE o.id = i.order_id),
               'tracking', (SELECT t.type || ' No. ' || t.number FROM vouchers t WHERE t.id = i.tracking_id))) ORDER BY i.line) list
        FROM inventory_entries i JOIN stock_items s ON s.id = i.item_id JOIN godowns g ON g.id = i.godown_id
       WHERE i.voucher_id = ANY(ids) GROUP BY i.voucher_id) i ON i.voucher_id = v.id
   WHERE v.id = ANY(ids)
   ORDER BY v.id;
END $$;
