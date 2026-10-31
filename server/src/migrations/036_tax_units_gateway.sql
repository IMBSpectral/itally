-- More GST registrations (tax units) in one company, as Tally's: the company's own GSTIN is the main
-- one; each further registration (a branch in another state) is named, and a voucher type
-- belongs to it, so its vouchers are taxed from that state and reported in that GSTIN's returns.
CREATE TABLE gst_registrations (
  id          serial PRIMARY KEY,
  company_id  int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        text NOT NULL,
  gstin       text NOT NULL,
  state       text NOT NULL
);
CREATE UNIQUE INDEX gst_registrations_gstin ON gst_registrations (company_id, upper(gstin));
CREATE UNIQUE INDEX gst_registrations_name ON gst_registrations (company_id, lower(name));
ALTER TABLE voucher_types ADD COLUMN gst_registration_id int REFERENCES gst_registrations(id);

-- Payment gateway reconciliation: the payments a gateway's settlement report lists (gross, its fee
-- and the GST on it, and the settlement that paid it out), matched to the receipts in the books.
CREATE TABLE gateway_payments (
  id                 serial PRIMARY KEY,
  company_id         int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  gateway            text NOT NULL,
  payment_id         text NOT NULL,
  date               date NOT NULL,
  amount             bigint NOT NULL,
  fee                bigint NOT NULL DEFAULT 0,
  tax                bigint NOT NULL DEFAULT 0,
  settlement_id      text,
  settled_on         date,
  reference          text,
  posted_voucher_id  int REFERENCES vouchers(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX gateway_payments_id ON gateway_payments (company_id, lower(gateway), payment_id);
