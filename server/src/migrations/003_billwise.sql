-- Bill-wise details: party ledgers keep their balance as individual bills (invoices), so the
-- books can say which bills are pending, when they fall due and how overdue they are.

ALTER TABLE ledgers
  ADD COLUMN billwise     boolean NOT NULL DEFAULT false,
  ADD COLUMN credit_days  int CHECK (credit_days IS NULL OR credit_days >= 0);

-- existing party ledgers start keeping bills; their earlier entries count as On Account
UPDATE ledgers l SET billwise = true
 WHERE EXISTS (
   WITH RECURSIVE up AS (SELECT id, parent_id, name FROM groups WHERE id = l.group_id
                         UNION ALL SELECT g.id, g.parent_id, g.name FROM groups g JOIN up ON g.id = up.parent_id)
   SELECT 1 FROM up WHERE name IN ('Sundry Debtors', 'Sundry Creditors'));

-- How one voucher entry on a bill-wise ledger splits across bills. Amounts are signed like
-- the entry (+ Dr) and add up to it. On Account has no bill name.
CREATE TABLE bill_allocations (
  id         bigserial PRIMARY KEY,
  entry_id   bigint NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  ledger_id  int NOT NULL REFERENCES ledgers(id),
  ref_type   text NOT NULL CHECK (ref_type IN ('New Ref', 'Agst Ref', 'Advance', 'On Account')),
  name       text,
  due_date   date,
  amount     bigint NOT NULL CHECK (amount <> 0),
  CHECK ((ref_type = 'On Account') = (name IS NULL))
);
CREATE INDEX bill_allocations_bill ON bill_allocations (ledger_id, lower(name));
CREATE INDEX bill_allocations_entry ON bill_allocations (entry_id);

-- Bills that make up a ledger's opening balance.
CREATE TABLE opening_bills (
  id         bigserial PRIMARY KEY,
  ledger_id  int NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  name       text NOT NULL,
  bill_date  date NOT NULL,
  due_date   date,
  amount     bigint NOT NULL CHECK (amount <> 0)
);
CREATE UNIQUE INDEX opening_bills_name ON opening_bills (ledger_id, lower(name));

-- An allocation belongs to the entry's ledger, and an entry's allocations add up to it
-- (checked at commit, like the voucher balance).
CREATE FUNCTION bill_allocations_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE eid bigint; entry_ledger int; entry_amount bigint; total bigint; n int;
BEGIN
  IF TG_OP = 'DELETE' THEN eid := OLD.entry_id; ELSE eid := NEW.entry_id; END IF;
  SELECT ledger_id, amount INTO entry_ledger, entry_amount FROM entries WHERE id = eid;
  IF NOT FOUND THEN RETURN NULL; END IF;  -- entry deleted in this transaction
  SELECT count(*), COALESCE(SUM(amount), 0) INTO n, total FROM bill_allocations WHERE entry_id = eid;
  IF n > 0 AND total <> entry_amount THEN
    RAISE EXCEPTION 'bill allocations of entry % add up to %, not %', eid, total, entry_amount
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM bill_allocations WHERE entry_id = eid AND ledger_id <> entry_ledger) THEN
    RAISE EXCEPTION 'bill allocation on entry % names another ledger', eid;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER bill_allocations_balanced AFTER INSERT OR UPDATE OR DELETE ON bill_allocations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bill_allocations_check();
