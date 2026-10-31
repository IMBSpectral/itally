-- Migration 012 moved the balance rule and the Edit Log of a batch into close_voucher_batch. The
-- entries' own row triggers (daily ledger totals, same-company check) still fired once per entry;
-- now they too stand aside while a batch is being inserted, and close_voucher_batch does their
-- work set-wise. The server turns app.voucher_batch on just before inserting a batch and off
-- right after closing it; outside that window every trigger runs as before.

CREATE OR REPLACE FUNCTION entries_daily() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d date;
BEGIN
  IF TG_OP = 'INSERT' AND voucher_batch() THEN RETURN NULL; END IF;   -- added up by close_voucher_batch
  IF TG_OP IN ('DELETE','UPDATE') THEN
    SELECT date INTO d FROM vouchers WHERE id = OLD.voucher_id;
    IF d IS NOT NULL THEN
      UPDATE ledger_daily SET dr = dr - GREATEST(OLD.amount, 0), cr = cr - GREATEST(-OLD.amount, 0)
       WHERE ledger_id = OLD.ledger_id AND day = d;
    END IF;
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
    SELECT date INTO d FROM vouchers WHERE id = NEW.voucher_id;
    INSERT INTO ledger_daily (ledger_id, day, dr, cr)
         VALUES (NEW.ledger_id, d, GREATEST(NEW.amount, 0), GREATEST(-NEW.amount, 0))
    ON CONFLICT (ledger_id, day) DO UPDATE
         SET dr = ledger_daily.dr + EXCLUDED.dr, cr = ledger_daily.cr + EXCLUDED.cr;
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION entries_same_company() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND voucher_batch() THEN RETURN NEW; END IF;   -- checked by close_voucher_batch
  IF (SELECT company_id FROM vouchers WHERE id = NEW.voucher_id)
     IS DISTINCT FROM (SELECT company_id FROM ledgers WHERE id = NEW.ledger_id) THEN
    RAISE EXCEPTION 'ledger % belongs to another company', NEW.ledger_id;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION inventory_same_company() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cid int;
BEGIN
  IF TG_OP = 'INSERT' AND voucher_batch() THEN RETURN NEW; END IF;   -- checked by close_voucher_batch
  SELECT company_id INTO cid FROM vouchers WHERE id = NEW.voucher_id;
  IF cid IS DISTINCT FROM (SELECT company_id FROM stock_items WHERE id = NEW.item_id)
     OR cid IS DISTINCT FROM (SELECT company_id FROM godowns WHERE id = NEW.godown_id) THEN
    RAISE EXCEPTION 'stock item or godown belongs to another company';
  END IF;
  RETURN NEW;
END $$;

-- 012's checks and log, plus the entries' daily totals and the same-company rules, set-wise.
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
               'ledgerId', e.ledger_id, 'ledger', l.name, 'amount', e.amount, 'bills', b.list) ORDER BY e.line) list
        FROM entries e JOIN ledgers l ON l.id = e.ledger_id
        LEFT JOIN (
          SELECT a.entry_id, jsonb_agg(jsonb_build_object('type', a.ref_type, 'name', a.name,
                   'dueDate', to_char(a.due_date, 'YYYY-MM-DD'), 'amount', a.amount) ORDER BY a.id) list
            FROM bill_allocations a JOIN entries x ON x.id = a.entry_id
           WHERE x.voucher_id = ANY(ids) GROUP BY a.entry_id) b ON b.entry_id = e.id
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
