-- Budgets, scenarios and reversing journals, as Tally's. A budget sets amounts for groups, ledgers or
-- cost centres over its period, on the nett transactions or the closing balance; the variance
-- report compares them with the books. A Reversing Journal, like a Memorandum voucher, is kept out
-- of the books (its lines in vouchers.draft) and is effective up to its applicable-upto date; a
-- scenario is the books (or not) plus the reversing journals, optional and memorandum vouchers it
-- includes, and Trial Balance, Profit & Loss and Balance Sheet can be shown under one.
ALTER TABLE vouchers ADD COLUMN applicable_upto date;

ALTER TABLE vouchers DROP CONSTRAINT vouchers_type_check;
ALTER TABLE vouchers ADD CONSTRAINT vouchers_type_check CHECK (type IN (
  'Contra', 'Payment', 'Receipt', 'Journal', 'Sales', 'Purchase', 'Credit Note', 'Debit Note',
  'Sales Order', 'Purchase Order', 'Delivery Note', 'Receipt Note', 'Stock Journal', 'Physical Stock', 'Memorandum', 'Payroll', 'Attendance',
  'Manufacturing Journal', 'Rejections In', 'Rejections Out', 'Material In', 'Material Out', 'Job Work In Order', 'Job Work Out Order', 'Reversing Journal'));
ALTER TABLE voucher_types DROP CONSTRAINT voucher_types_base_type_check;
ALTER TABLE voucher_types ADD CONSTRAINT voucher_types_base_type_check CHECK (base_type IN (
  'Contra', 'Payment', 'Receipt', 'Journal', 'Sales', 'Purchase', 'Credit Note', 'Debit Note',
  'Sales Order', 'Purchase Order', 'Delivery Note', 'Receipt Note', 'Stock Journal', 'Physical Stock', 'Memorandum', 'Payroll', 'Attendance',
  'Manufacturing Journal', 'Rejections In', 'Rejections Out', 'Material In', 'Material Out', 'Job Work In Order', 'Job Work Out Order', 'Reversing Journal'));
ALTER TABLE vouchers DROP CONSTRAINT vouchers_draft_check;
ALTER TABLE vouchers ADD CONSTRAINT vouchers_draft_check CHECK ((optional OR type IN ('Memorandum', 'Reversing Journal')) = (draft IS NOT NULL));
ALTER TABLE vouchers ADD CONSTRAINT vouchers_applicable_upto_check
  CHECK ((type = 'Reversing Journal') = (applicable_upto IS NOT NULL) AND (applicable_upto IS NULL OR applicable_upto >= date));

-- Double entry at COMMIT; a Reversing Journal, like a Memorandum, has no entries (copied from 029).
CREATE OR REPLACE FUNCTION voucher_balance_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE vid int; n int; total bigint; is_cancelled boolean; vtype text; is_draft boolean;
BEGIN
  IF voucher_batch() THEN RETURN NULL; END IF;   -- close_voucher_batch checks the whole batch
  IF TG_TABLE_NAME = 'vouchers' THEN vid := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN vid := OLD.voucher_id;
  ELSE vid := NEW.voucher_id;
  END IF;
  SELECT cancelled, type, optional OR type IN ('Memorandum', 'Reversing Journal') INTO is_cancelled, vtype, is_draft FROM vouchers WHERE id = vid;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*), COALESCE(SUM(amount), 0) INTO n, total FROM entries WHERE voucher_id = vid;
  IF is_cancelled OR is_draft THEN
    IF n > 0 THEN RAISE EXCEPTION 'voucher % is out of the books but still has entries', vid; END IF;
  ELSIF vtype IN ('Sales Order', 'Purchase Order', 'Delivery Note', 'Receipt Note', 'Stock Journal', 'Physical Stock', 'Attendance',
                  'Manufacturing Journal', 'Rejections In', 'Rejections Out', 'Material In', 'Material Out', 'Job Work In Order', 'Job Work Out Order') THEN
    IF n > 0 THEN RAISE EXCEPTION 'a % has no ledger entries', vtype USING ERRCODE = 'check_violation'; END IF;
  ELSIF n < 2 OR total <> 0 THEN
    RAISE EXCEPTION 'voucher % is not balanced (entries %, difference %)', vid, n, total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE TABLE budgets (
  id          serial PRIMARY KEY,
  company_id  int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        text NOT NULL,
  parent_id   int REFERENCES budgets(id),
  from_date   date NOT NULL,
  to_date     date NOT NULL CHECK (to_date >= from_date)
);
CREATE UNIQUE INDEX budgets_name ON budgets (company_id, lower(name));

-- one amount per budget and group, ledger or cost centre; + is Dr
CREATE TABLE budget_lines (
  budget_id       int NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  group_id        int REFERENCES groups(id) ON DELETE CASCADE,
  ledger_id       int REFERENCES ledgers(id) ON DELETE CASCADE,
  cost_centre_id  int REFERENCES cost_centres(id) ON DELETE CASCADE,
  type            text NOT NULL CHECK (type IN ('nett', 'closing')),
  amount          bigint NOT NULL,
  CHECK (num_nonnulls(group_id, ledger_id, cost_centre_id) = 1)
);
CREATE UNIQUE INDEX budget_lines_target ON budget_lines (budget_id, COALESCE(group_id, 0), COALESCE(ledger_id, 0), COALESCE(cost_centre_id, 0));

CREATE TABLE scenarios (
  id               serial PRIMARY KEY,
  company_id       int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name             text NOT NULL,
  include_actuals  boolean NOT NULL DEFAULT true,
  include          text[] NOT NULL DEFAULT '{Reversing Journal}'   -- of 'Reversing Journal', 'Optional', 'Memorandum'
);
CREATE UNIQUE INDEX scenarios_name ON scenarios (company_id, lower(name));
