-- Tally Audit: an auditor's mark on a voucher (audited, or under observation), with the version of
-- the voucher it was made on, so a voucher altered afterwards shows as altered after audit.
CREATE TABLE audit_marks (
  voucher_id  int PRIMARY KEY REFERENCES vouchers(id) ON DELETE CASCADE,
  status      text NOT NULL CHECK (status IN ('Audited', 'Under Observation')),
  version     int NOT NULL,
  auditor     text NOT NULL,
  at          timestamptz NOT NULL DEFAULT now(),
  note        text NOT NULL DEFAULT ''
);

-- POS invoicing: a Sales voucher type used at the counter; its vouchers make the POS Register.
ALTER TABLE voucher_types ADD COLUMN pos boolean NOT NULL DEFAULT false;

-- Read-only views for reporting tools over SQL (ODBC through the PostgreSQL driver), as Tally's ODBC
-- collections: amounts in rupees, debits positive, quantities in the item's unit. Optional and
-- memorandum vouchers keep their lines out of the books, so they have no ledger entries here.
CREATE SCHEMA IF NOT EXISTS odbc;

CREATE VIEW odbc.company AS
  SELECT id company_id, name, books_begin, fy_start, gstin, state FROM companies;

CREATE VIEW odbc.groups AS
  SELECT g.company_id, g.name, p.name parent, g.nature FROM groups g LEFT JOIN groups p ON p.id = g.parent_id;

CREATE VIEW odbc.ledger AS
  SELECT l.company_id, l.id ledger_id, l.name, g.name parent, l.opening / 100.0 opening_balance, l.gstin, l.state, l.pan
    FROM ledgers l LEFT JOIN groups g ON g.id = l.group_id;

CREATE VIEW odbc.voucher AS
  SELECT v.company_id, v.id voucher_id, v.date, v.type voucher_type, (SELECT name FROM voucher_types t WHERE t.id = v.voucher_type_id) voucher_type_name,
         COALESCE(v.doc_no, v.number::text) voucher_number, p.name party, v.narration, v.cancelled, v.optional
    FROM vouchers v LEFT JOIN ledgers p ON p.id = v.party_ledger_id;

CREATE VIEW odbc.ledger_entry AS
  SELECT v.company_id, v.id voucher_id, v.date, v.type voucher_type, COALESCE(v.doc_no, v.number::text) voucher_number, l.name ledger,
         e.amount / 100.0 amount, GREATEST(e.amount, 0) / 100.0 debit, GREATEST(-e.amount, 0) / 100.0 credit
    FROM entries e JOIN vouchers v ON v.id = e.voucher_id JOIN ledgers l ON l.id = e.ledger_id
   WHERE NOT v.cancelled;

CREATE VIEW odbc.stock_item AS
  SELECT s.company_id, s.id item_id, s.name, g.name stock_group, u.symbol unit, s.opening_qty / 1000.0 opening_qty, s.opening_value / 100.0 opening_value, s.hsn
    FROM stock_items s LEFT JOIN stock_groups g ON g.id = s.group_id JOIN units u ON u.id = s.unit_id;

CREATE VIEW odbc.inventory_entry AS
  SELECT v.company_id, v.id voucher_id, v.date, v.type voucher_type, COALESCE(v.doc_no, v.number::text) voucher_number, s.name item, gd.name godown,
         i.qty / 1000.0 qty, i.rate / 100.0 rate, i.amount / 100.0 amount
    FROM inventory_entries i JOIN vouchers v ON v.id = i.voucher_id JOIN stock_items s ON s.id = i.item_id JOIN godowns gd ON gd.id = i.godown_id
   WHERE NOT v.cancelled;
