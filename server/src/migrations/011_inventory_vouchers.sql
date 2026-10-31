-- Inventory vouchers, as in Tally: Sales/Purchase Orders, Delivery/Receipt Notes, Stock Journal and
-- Physical Stock. They carry item lines but no ledger entries. Orders move no stock; a note moves
-- it, and the invoice made against the note then books the sale or purchase without moving it again.

ALTER TABLE vouchers DROP CONSTRAINT vouchers_type_check;
ALTER TABLE vouchers ADD CONSTRAINT vouchers_type_check CHECK (type IN (
  'Contra', 'Payment', 'Receipt', 'Journal', 'Sales', 'Purchase', 'Credit Note', 'Debit Note',
  'Sales Order', 'Purchase Order', 'Delivery Note', 'Receipt Note', 'Stock Journal', 'Physical Stock'));

-- the party of an order or note (invoices name theirs in their entries)
ALTER TABLE vouchers ADD COLUMN party_ledger_id int REFERENCES ledgers(id);

ALTER TABLE inventory_entries
  ADD COLUMN moves_stock boolean NOT NULL DEFAULT true,     -- false on orders and on lines invoiced against a note
  ADD COLUMN counted bigint CHECK (counted >= 0),           -- Physical Stock: the quantity counted; qty is the difference
  ADD COLUMN order_id int REFERENCES vouchers(id),          -- the order this line fulfils
  ADD COLUMN tracking_id int REFERENCES vouchers(id),       -- the note this line was invoiced against
  ADD COLUMN due_date date;                                 -- order lines: when the goods are due
ALTER TABLE inventory_entries DROP CONSTRAINT inventory_entries_qty_check;
ALTER TABLE inventory_entries ADD CONSTRAINT inventory_entries_qty_check CHECK (qty <> 0 OR counted IS NOT NULL);
CREATE INDEX inventory_entries_order ON inventory_entries (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX inventory_entries_tracking ON inventory_entries (tracking_id) WHERE tracking_id IS NOT NULL;

-- Double entry, checked at COMMIT. Inventory vouchers have no entries at all; every other live
-- voucher has at least two summing to zero; a cancelled voucher keeps its number but has none.
CREATE OR REPLACE FUNCTION voucher_balance_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE vid int; n int; total bigint; is_cancelled boolean; vtype text;
BEGIN
  IF TG_TABLE_NAME = 'vouchers' THEN vid := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN vid := OLD.voucher_id;
  ELSE vid := NEW.voucher_id;
  END IF;
  SELECT cancelled, type INTO is_cancelled, vtype FROM vouchers WHERE id = vid;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*), COALESCE(SUM(amount), 0) INTO n, total FROM entries WHERE voucher_id = vid;
  IF is_cancelled THEN
    IF n > 0 THEN RAISE EXCEPTION 'cancelled voucher % still has entries', vid; END IF;
  ELSIF vtype IN ('Sales Order', 'Purchase Order', 'Delivery Note', 'Receipt Note', 'Stock Journal', 'Physical Stock') THEN
    IF n > 0 THEN RAISE EXCEPTION 'a % has no ledger entries', vtype USING ERRCODE = 'check_violation'; END IF;
  ELSIF n < 2 OR total <> 0 THEN
    RAISE EXCEPTION 'voucher % is not balanced (entries %, difference %)', vid, n, total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

-- The party must be the voucher's own company's ledger.
CREATE FUNCTION vouchers_party_company() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.party_ledger_id IS NOT NULL AND
     NEW.company_id IS DISTINCT FROM (SELECT company_id FROM ledgers WHERE id = NEW.party_ledger_id) THEN
    RAISE EXCEPTION 'party ledger belongs to another company';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vouchers_party_company BEFORE INSERT OR UPDATE OF party_ledger_id ON vouchers
  FOR EACH ROW EXECUTE FUNCTION vouchers_party_company();

-- The Edit Log's picture of a voucher now has its party and the tracking of its item lines.
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
                           FROM bill_allocations a WHERE a.entry_id = e.id)) ORDER BY e.line)
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
