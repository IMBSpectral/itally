-- GST beyond plain invoices.
--   * reverse charge: a purchase or expense ledger whose GST the buyer pays (GTA freight, legal
--     services, purchases from the unregistered where notified);
--   * GST adjustments: a Journal that reverses input tax credit or reclaims it (GSTR-3B 4B / 4D);
--   * filed months: once GSTR-1 for a month is marked filed, later changes to that month's
--     invoices are reported as amendments in the month they are made.
ALTER TABLE ledgers ADD COLUMN reverse_charge boolean NOT NULL DEFAULT false;
ALTER TABLE vouchers ADD COLUMN gst_adjustment text CHECK (gst_adjustment IN ('itc-reversal', 'itc-reclaim'));
CREATE TABLE gst_filings (
  company_id  int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  month       text NOT NULL CHECK (month ~ '^[0-9]{4}-[0-9]{2}$'),
  filed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, month)
);
