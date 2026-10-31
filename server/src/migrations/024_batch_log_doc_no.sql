-- A batch import logs its vouchers as a single posting does (023 added the number shown and the
-- voucher type to voucher_snapshot). Copied from 018, with those two keys and the label.
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
  SELECT v.company_id, 'voucher', v.id, 'create', v.type || ' No. ' || COALESCE(v.doc_no, v.number::text),
         jsonb_build_object(
           'type', v.type, 'number', v.number, 'docNo', COALESCE(v.doc_no, v.number::text),
           'voucherType', (SELECT name FROM voucher_types t WHERE t.id = v.voucher_type_id), 'date', to_char(v.date, 'YYYY-MM-DD'),
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
