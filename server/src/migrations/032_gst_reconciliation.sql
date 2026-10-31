-- More of Tally's GST: the supplier's invoice number and date on a purchase (what GSTR-2B carries),
-- advances received for services taxed on receipt (GSTR-1 tables 11A/11B), composition dealers
-- (CMP-08, GSTR-4), the documents the portal holds (GSTR-2B for inward supplies with the IMS action
-- taken on each, a filed GSTR-1 for outward ones) to reconcile with the books, and the challans
-- (CPIN, CIN) of GST paid in cash.
ALTER TABLE vouchers
  ADD COLUMN ref_no text,                -- the supplier's invoice or note number
  ADD COLUMN ref_date date,              -- and its date
  ADD COLUMN advance_rate int CHECK (advance_rate BETWEEN 0 AND 10000);   -- a receipt in advance: the GST rate it is taxed at

ALTER TABLE companies
  ADD COLUMN gst_type text NOT NULL DEFAULT 'Regular' CHECK (gst_type IN ('Regular', 'Composition')),
  ADD COLUMN composition_rate int CHECK (composition_rate BETWEEN 0 AND 10000);   -- CGST and SGST together, hundredths of a percent

CREATE TABLE gst_portal_docs (
  id          serial PRIMARY KEY,
  company_id  int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source      text NOT NULL CHECK (source IN ('2B', 'GSTR-1')),
  month       text NOT NULL CHECK (month ~ '^[0-9]{4}-[0-9]{2}$'),   -- the return period
  gstin       text NOT NULL,                                          -- the supplier's (2B) or the customer's (GSTR-1)
  party       text,
  doc_type    text NOT NULL CHECK (doc_type IN ('Invoice', 'Credit Note', 'Debit Note')),
  doc_no      text NOT NULL,
  doc_date    date NOT NULL,
  pos         text,
  rcm         boolean NOT NULL DEFAULT false,
  taxable     bigint NOT NULL,
  igst        bigint NOT NULL DEFAULT 0,
  cgst        bigint NOT NULL DEFAULT 0,
  sgst        bigint NOT NULL DEFAULT 0,
  cess        bigint NOT NULL DEFAULT 0,
  value       bigint NOT NULL,
  ims_action  text NOT NULL DEFAULT 'Pending' CHECK (ims_action IN ('Accepted', 'Rejected', 'Pending'))
);
CREATE UNIQUE INDEX gst_portal_docs_doc ON gst_portal_docs (company_id, source, gstin, doc_type, upper(doc_no), doc_date);

CREATE TABLE gst_challans (
  voucher_id    int PRIMARY KEY REFERENCES vouchers(id) ON DELETE CASCADE,
  cpin          text NOT NULL CHECK (cpin ~ '^[0-9]{14}$'),
  cin           text CHECK (cin ~ '^[0-9A-Z]{17,20}$'),
  deposit_date  date NOT NULL
);
