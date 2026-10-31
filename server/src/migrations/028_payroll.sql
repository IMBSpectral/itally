-- Payroll, as Tally keeps it. Employees are cost centres (their categories are cost categories,
-- their groups cost centres above them), so salaries split by employee through cost allocations
-- and every cost centre report shows them. A pay head is a ledger with payroll details. The
-- salary structure of an employee (or of a whole group) is kept from a date. Attendance and
-- production are recorded by Attendance vouchers, which have no ledger entries; a Payroll voucher
-- is an ordinary balanced voucher whose pay head lines are split by employee.

ALTER TABLE cost_centres ADD COLUMN kind text NOT NULL DEFAULT 'centre' CHECK (kind IN ('centre', 'employee group', 'employee'));

CREATE TABLE employees (
  cost_centre_id   int PRIMARY KEY REFERENCES cost_centres(id) ON DELETE CASCADE,
  number           text,
  designation      text,
  department       text,
  location         text,
  gender           text CHECK (gender IN ('Male', 'Female', 'Other')),
  date_of_birth    date,
  date_of_joining  date NOT NULL,
  date_of_leaving  date,
  pan              text CHECK (pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  uan              text CHECK (uan ~ '^[0-9]{12}$'),
  pf_number        text,
  esi_number       text CHECK (esi_number ~ '^[0-9]{10}$'),
  pran             text CHECK (pran ~ '^[0-9]{12}$'),
  bank_name        text,
  account_no       text,
  ifsc             text CHECK (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  tax_regime       text NOT NULL DEFAULT 'new' CHECK (tax_regime IN ('new', 'old')),
  CHECK (date_of_leaving IS NULL OR date_of_leaving >= date_of_joining)
);

CREATE TABLE attendance_types (
  id          serial PRIMARY KEY,
  company_id  int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (btrim(name) <> ''),
  kind        text NOT NULL CHECK (kind IN ('attendance', 'leave with pay', 'leave without pay', 'production')),
  unit        text NOT NULL DEFAULT 'Days'
);
CREATE UNIQUE INDEX attendance_types_name ON attendance_types (company_id, lower(name));

-- formula: [{ payHeadId, sign: 1 | -1 }]; slabs: [{ upTo: paise | null, rate: hundredths of a percent, value: paise }]
CREATE TABLE pay_heads (
  ledger_id           int PRIMARY KEY REFERENCES ledgers(id) ON DELETE CASCADE,
  pay_type            text NOT NULL CHECK (pay_type IN ('Earnings for Employees', 'Deductions from Employees', 'Employees'' Statutory Deductions',
                        'Employer''s Statutory Contributions', 'Employer''s Other Charges', 'Bonus', 'Gratuity', 'Loans and Advances', 'Reimbursements to Employees')),
  statutory           text CHECK (statutory IN ('pf', 'eps', 'epf-employer', 'edli', 'pf-admin', 'esi', 'esi-employer', 'pt', 'income-tax', 'nps', 'nps-employer')),
  calculation         text NOT NULL CHECK (calculation IN ('user', 'flat', 'attendance', 'production', 'computed')),
  attendance_type_id  int REFERENCES attendance_types(id),
  per_day_days        int CHECK (per_day_days BETWEEN 1 AND 31),            -- null: the days of the calendar period
  formula             jsonb NOT NULL DEFAULT '[]',
  ceiling             bigint CHECK (ceiling > 0),                             -- the base is capped here (PF), or ESI stops above it
  slabs               jsonb NOT NULL DEFAULT '[]',
  rounding            text NOT NULL DEFAULT 'normal' CHECK (rounding IN ('normal', 'up', 'down', 'none')),
  round_to            int NOT NULL DEFAULT 100 CHECK (round_to > 0),
  expense_ledger_id   int REFERENCES ledgers(id),                             -- an employer's contribution is debited here
  CHECK ((calculation IN ('attendance', 'production')) = (attendance_type_id IS NOT NULL))
);

-- lines: [{ payHeadId, rate: paise | null }], in the order they are computed
CREATE TABLE salary_details (
  id              serial PRIMARY KEY,
  cost_centre_id  int NOT NULL REFERENCES cost_centres(id) ON DELETE CASCADE,
  effective_from  date NOT NULL,
  lines           jsonb NOT NULL,
  UNIQUE (cost_centre_id, effective_from)
);

CREATE TABLE attendance_entries (
  id                  bigserial PRIMARY KEY,
  voucher_id          int NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  line                int NOT NULL,
  employee_id         int NOT NULL REFERENCES cost_centres(id),
  attendance_type_id  int NOT NULL REFERENCES attendance_types(id),
  value               bigint NOT NULL CHECK (value <> 0)                      -- thousandths of the type's unit
);
CREATE INDEX attendance_entries_voucher ON attendance_entries (voucher_id);
CREATE INDEX attendance_entries_employee ON attendance_entries (employee_id);

ALTER TABLE vouchers DROP CONSTRAINT vouchers_type_check;
ALTER TABLE vouchers ADD CONSTRAINT vouchers_type_check CHECK (type IN (
  'Contra', 'Payment', 'Receipt', 'Journal', 'Sales', 'Purchase', 'Credit Note', 'Debit Note',
  'Sales Order', 'Purchase Order', 'Delivery Note', 'Receipt Note', 'Stock Journal', 'Physical Stock', 'Memorandum', 'Payroll', 'Attendance'));
ALTER TABLE voucher_types DROP CONSTRAINT voucher_types_base_type_check;
ALTER TABLE voucher_types ADD CONSTRAINT voucher_types_base_type_check CHECK (base_type IN (
  'Contra', 'Payment', 'Receipt', 'Journal', 'Sales', 'Purchase', 'Credit Note', 'Debit Note',
  'Sales Order', 'Purchase Order', 'Delivery Note', 'Receipt Note', 'Stock Journal', 'Physical Stock', 'Memorandum', 'Payroll', 'Attendance'));

-- Double entry at COMMIT; an Attendance voucher has no ledger entries (copied from 018).
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
  ELSIF vtype IN ('Sales Order', 'Purchase Order', 'Delivery Note', 'Receipt Note', 'Stock Journal', 'Physical Stock', 'Attendance') THEN
    IF n > 0 THEN RAISE EXCEPTION 'a % has no ledger entries', vtype USING ERRCODE = 'check_violation'; END IF;
  ELSIF n < 2 OR total <> 0 THEN
    RAISE EXCEPTION 'voucher % is not balanced (entries %, difference %)', vid, n, total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
