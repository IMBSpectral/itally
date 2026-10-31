-- Loans and advances to employees: given on a date, recovered in monthly instalments through a
-- pay head of type 'Loans and Advances' (pay heads are keyed by their ledger) from a month on.
CREATE TABLE employee_loans (
  id           serial PRIMARY KEY,
  company_id   int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id  int NOT NULL REFERENCES cost_centres(id) ON DELETE CASCADE,
  pay_head_id  int NOT NULL REFERENCES ledgers(id),
  given_on     date NOT NULL,
  amount       bigint NOT NULL CHECK (amount > 0),
  instalment   bigint NOT NULL CHECK (instalment > 0),
  recover_from date NOT NULL,
  note         text NOT NULL DEFAULT '',
  CHECK (recover_from >= given_on)
);
CREATE INDEX employee_loans_employee ON employee_loans (employee_id);

-- The old tax regime: what an employee declares for a financial year (paise): the year's rent (for
-- the HRA exemption, a metro city or not) and the Chapter VI-A deductions and home-loan interest.
CREATE TABLE tax_declarations (
  employee_id  int NOT NULL REFERENCES cost_centres(id) ON DELETE CASCADE,
  fy_start     date NOT NULL,
  rent_paid    bigint NOT NULL DEFAULT 0 CHECK (rent_paid >= 0),
  metro        boolean NOT NULL DEFAULT false,
  sec80c       bigint NOT NULL DEFAULT 0 CHECK (sec80c >= 0),
  sec80d       bigint NOT NULL DEFAULT 0 CHECK (sec80d >= 0),
  sec80ccd1b   bigint NOT NULL DEFAULT 0 CHECK (sec80ccd1b >= 0),
  sec24b       bigint NOT NULL DEFAULT 0 CHECK (sec24b >= 0),
  other        bigint NOT NULL DEFAULT 0 CHECK (other >= 0),
  PRIMARY KEY (employee_id, fy_start)
);

-- A pay head's part in the tax computation: Basic (with DA) and HRA give the HRA exemption.
ALTER TABLE pay_heads ADD COLUMN tax_component text CHECK (tax_component IN ('basic', 'hra'));
