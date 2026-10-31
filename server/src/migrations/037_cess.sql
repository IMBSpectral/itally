-- GST compensation cess: an ad valorem rate (hundredths of a percent) on a stock item or a
-- taxable ledger, as its GST rate is; a GST classification's cess rate replaces the master's.
ALTER TABLE ledgers ADD COLUMN cess_rate int CHECK (cess_rate BETWEEN 0 AND 100000);
ALTER TABLE stock_items ADD COLUMN cess_rate int CHECK (cess_rate BETWEEN 0 AND 100000);
ALTER TABLE gst_classifications ADD COLUMN cess_rate int CHECK (cess_rate BETWEEN 0 AND 100000);

-- A GSTR-2B or GSTR-1 file is for one GSTIN: the company's own (null) or a further registration's.
ALTER TABLE gst_portal_docs ADD COLUMN registration_id int REFERENCES gst_registrations(id) ON DELETE CASCADE;
