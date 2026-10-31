-- A party's own TDS rate: a certificate for lower or no deduction (section 197) for a period and
-- up to an amount, or the rate of a tax treaty (DTAA) for a non-resident; for one nature of
-- payment, or every one (null). Rates in hundredths of a percent, as the natures' are.
CREATE TABLE tds_party_rates (
  id              serial PRIMARY KEY,
  company_id      int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  ledger_id       int NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  nature_id       int REFERENCES tds_natures(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('certificate', 'dtaa')),
  rate            int NOT NULL CHECK (rate BETWEEN 0 AND 10000),
  certificate_no  text,
  valid_from      date NOT NULL,
  valid_to        date NOT NULL,
  amount_limit    bigint CHECK (amount_limit > 0),
  CHECK (valid_to >= valid_from)
);
CREATE INDEX tds_party_rates_ledger ON tds_party_rates (ledger_id);
