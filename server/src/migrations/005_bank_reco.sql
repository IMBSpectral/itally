-- Bank reconciliation: the date each bank entry cleared in the bank's own books.
-- Null = not yet reflected in the bank statement.
ALTER TABLE entries ADD COLUMN bank_date date;
CREATE INDEX entries_unreconciled ON entries (ledger_id) WHERE bank_date IS NULL;
