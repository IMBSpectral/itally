-- Voucher Types, company features (F11) and stock categories, as in Tally.
--
-- A voucher type is a named kind of voucher under one of the predefined ones ("Sales - Export"
-- under Sales) with its own numbering: automatic with a prefix, suffix, width and starting number
-- (restarting each financial year if asked), or typed by hand. The number users see is
-- vouchers.doc_no ("INV/0007/26-27"); vouchers.number stays the internal sequence per
-- predefined type that links, backups and imports use. A voucher of a predefined type has no
-- doc_no and shows its number.
--
-- companies.features switches parts of the product off (F11), so a company that keeps no stock or
-- bills sees none of their screens or fields. Absent keys are on.
--
-- A stock category cuts across stock groups (a brand, a size), for the Stock Category Summary.

CREATE TABLE voucher_types (
  id              serial PRIMARY KEY,
  company_id      int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name            text NOT NULL,
  base_type       text NOT NULL CHECK (base_type IN ('Contra', 'Payment', 'Receipt', 'Journal', 'Sales', 'Purchase', 'Credit Note', 'Debit Note',
                    'Sales Order', 'Purchase Order', 'Delivery Note', 'Receipt Note', 'Stock Journal', 'Physical Stock', 'Memorandum')),
  abbreviation    text NOT NULL DEFAULT '',
  numbering       text NOT NULL DEFAULT 'auto' CHECK (numbering IN ('auto', 'manual')),
  prefix          text NOT NULL DEFAULT '',
  suffix          text NOT NULL DEFAULT '',
  start_number    int NOT NULL DEFAULT 1 CHECK (start_number >= 0),
  width           int NOT NULL DEFAULT 0 CHECK (width BETWEEN 0 AND 9),     -- zero-filled to this many digits
  restart_yearly  boolean NOT NULL DEFAULT false,
  print_title     text,                                                      -- "Tax Invoice", "Export Invoice"
  active          boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX voucher_types_name ON voucher_types (company_id, lower(name));

-- the last number given per voucher type (and financial year, when it restarts each year)
CREATE TABLE voucher_type_counters (
  voucher_type_id int NOT NULL REFERENCES voucher_types(id) ON DELETE CASCADE,
  fy_start        date NOT NULL,
  last            int NOT NULL,
  PRIMARY KEY (voucher_type_id, fy_start)
);

ALTER TABLE vouchers
  ADD COLUMN voucher_type_id int REFERENCES voucher_types(id),
  ADD COLUMN doc_no text;
CREATE UNIQUE INDEX vouchers_doc_no ON vouchers (company_id, type, lower(doc_no)) WHERE doc_no IS NOT NULL;
CREATE INDEX vouchers_voucher_type ON vouchers (voucher_type_id) WHERE voucher_type_id IS NOT NULL;

ALTER TABLE companies ADD COLUMN features jsonb NOT NULL DEFAULT '{}';

CREATE TABLE stock_categories (
  id          serial PRIMARY KEY,
  company_id  int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        text NOT NULL,
  parent_id   int REFERENCES stock_categories(id) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX stock_categories_name ON stock_categories (company_id, lower(name));
ALTER TABLE stock_items ADD COLUMN category_id int REFERENCES stock_categories(id);

-- The Edit Log names a voucher by the number users see, and keeps it in the snapshot (GST
-- amendments report the number the filed return carried). Copied from 018 and 012.
CREATE OR REPLACE FUNCTION voucher_snapshot(vid int) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'type', v.type, 'number', v.number, 'docNo', COALESCE(v.doc_no, v.number::text),
    'voucherType', (SELECT name FROM voucher_types WHERE id = v.voucher_type_id), 'date', to_char(v.date, 'YYYY-MM-DD'),
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
               'order', (SELECT o.type || ' No. ' || COALESCE(o.doc_no, o.number::text) FROM vouchers o WHERE o.id = i.order_id),
               'tracking', (SELECT t.type || ' No. ' || COALESCE(t.doc_no, t.number::text) FROM vouchers t WHERE t.id = i.tracking_id))) ORDER BY i.line)
        FROM inventory_entries i JOIN stock_items s ON s.id = i.item_id JOIN godowns g ON g.id = i.godown_id
       WHERE i.voucher_id = v.id), '[]'::jsonb))
  FROM vouchers v WHERE v.id = vid
$$;

CREATE OR REPLACE FUNCTION log_voucher_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE snap jsonb;
BEGIN
  IF voucher_batch() THEN RETURN NULL; END IF;   -- close_voucher_batch logs the whole batch
  snap := voucher_snapshot(NEW.id);
  IF snap IS NULL THEN RETURN NULL; END IF;
  INSERT INTO edit_log (company_id, entity, entity_id, action, label, data)
  VALUES (NEW.company_id, 'voucher', NEW.id,
          CASE WHEN TG_OP = 'INSERT' THEN 'create'
               WHEN NEW.cancelled AND NOT OLD.cancelled THEN 'cancel' ELSE 'alter' END,
          NEW.type || ' No. ' || COALESCE(NEW.doc_no, NEW.number::text), snap);
  RETURN NULL;
END $$;
