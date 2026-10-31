-- Ledger mailing details, and optional and memorandum vouchers, as in Tally.
--
-- A party ledger carries its mailing name, address, PIN code, country, phone, e-mail and PAN.
--
-- An optional voucher (Ctrl+L) and a Memorandum voucher are kept but stay out of the books: their
-- entries and item lines are held in vouchers.draft (the voucher as entered) instead of in
-- entries / inventory_entries, so no balance, report, bill or stock figure sees them. Making an
-- optional voucher regular posts the draft like any new voucher.

ALTER TABLE ledgers
  ADD COLUMN mailing_name text,
  ADD COLUMN address text,
  ADD COLUMN pincode text,
  ADD COLUMN country text,
  ADD COLUMN phone text,
  ADD COLUMN email text,
  ADD COLUMN pan text CHECK (pan IS NULL OR pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$');

ALTER TABLE vouchers DROP CONSTRAINT vouchers_type_check;
ALTER TABLE vouchers ADD CONSTRAINT vouchers_type_check CHECK (type IN (
  'Contra', 'Payment', 'Receipt', 'Journal', 'Sales', 'Purchase', 'Credit Note', 'Debit Note',
  'Sales Order', 'Purchase Order', 'Delivery Note', 'Receipt Note', 'Stock Journal', 'Physical Stock', 'Memorandum'));
ALTER TABLE vouchers
  ADD COLUMN optional boolean NOT NULL DEFAULT false,
  ADD COLUMN draft jsonb,
  ADD CONSTRAINT vouchers_draft_check CHECK ((optional OR type = 'Memorandum') = (draft IS NOT NULL));

-- Double entry at COMMIT: an optional or memorandum voucher has no entries of its own.
CREATE OR REPLACE FUNCTION voucher_balance_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE vid int; n int; total bigint; is_cancelled boolean; vtype text; is_draft boolean;
BEGIN
  IF voucher_batch() THEN RETURN NULL; END IF;   -- close_voucher_batch checks the whole batch
  IF TG_TABLE_NAME = 'vouchers' THEN vid := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN vid := OLD.voucher_id;
  ELSE vid := NEW.voucher_id;
  END IF;
  SELECT cancelled, type, optional OR type = 'Memorandum' INTO is_cancelled, vtype, is_draft FROM vouchers WHERE id = vid;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*), COALESCE(SUM(amount), 0) INTO n, total FROM entries WHERE voucher_id = vid;
  IF is_cancelled OR is_draft THEN
    IF n > 0 THEN RAISE EXCEPTION 'voucher % is out of the books but still has entries', vid; END IF;
  ELSIF vtype IN ('Sales Order', 'Purchase Order', 'Delivery Note', 'Receipt Note', 'Stock Journal', 'Physical Stock') THEN
    IF n > 0 THEN RAISE EXCEPTION 'a % has no ledger entries', vtype USING ERRCODE = 'check_violation'; END IF;
  ELSIF n < 2 OR total <> 0 THEN
    RAISE EXCEPTION 'voucher % is not balanced (entries %, difference %)', vid, n, total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

-- The Edit Log's picture of a voucher carries the draft (from 017's definitions, the latest).
CREATE OR REPLACE FUNCTION voucher_snapshot(vid int) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'type', v.type, 'number', v.number, 'date', to_char(v.date, 'YYYY-MM-DD'),
    'narration', v.narration, 'cancelled', v.cancelled, 'version', v.version, 'postDated', v.post_dated,
    'optional', v.optional, 'draft', v.draft,
    'party', (SELECT name FROM ledgers WHERE id = v.party_ledger_id),
    'entries', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'ledgerId', e.ledger_id, 'ledger', l.name, 'amount', e.amount,
               'cheque', CASE WHEN e.instrument_no IS NULL AND e.instrument_date IS NULL THEN NULL
                              ELSE jsonb_build_object('no', e.instrument_no, 'date', to_char(e.instrument_date, 'YYYY-MM-DD')) END,
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

-- A batch's Edit Log the same way, and drafts pass the batch balance check.
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
  HAVING CASE WHEN v.cancelled OR v.optional OR v.type = 'Memorandum' OR v.type IN ('Sales Order', 'Purchase Order', 'Delivery Note', 'Receipt Note', 'Stock Journal', 'Physical Stock')
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
           'narration', v.narration, 'cancelled', v.cancelled, 'version', v.version, 'postDated', v.post_dated,
           'optional', v.optional, 'draft', v.draft,
           'party', p.name,
           'entries', COALESCE(e.list, '[]'::jsonb),
           'inventory', COALESCE(i.list, '[]'::jsonb))
    FROM vouchers v
    LEFT JOIN ledgers p ON p.id = v.party_ledger_id
    LEFT JOIN (
      SELECT e.voucher_id, jsonb_agg(jsonb_build_object(
               'ledgerId', e.ledger_id, 'ledger', l.name, 'amount', e.amount,
               'cheque', CASE WHEN e.instrument_no IS NULL AND e.instrument_date IS NULL THEN NULL
                              ELSE jsonb_build_object('no', e.instrument_no, 'date', to_char(e.instrument_date, 'YYYY-MM-DD')) END,
               'bills', b.list, 'costs', c.list) ORDER BY e.line) list
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
