-- GST: tax ledgers say which tax they hold; sales/purchase (and other taxable) ledgers and stock
-- items carry a rate (hundredths of a percent, 1800 = 18%) and an HSN/SAC code. Each invoice keeps
-- its GST breakup as posted, so the returns don't change when a rate is altered later.
ALTER TABLE ledgers
  ADD COLUMN gst_tax_type text CHECK (gst_tax_type IN ('IGST', 'CGST', 'SGST', 'Cess')),
  ADD COLUMN gst_rate int CHECK (gst_rate BETWEEN 0 AND 10000),
  ADD COLUMN hsn text;
ALTER TABLE stock_items
  ADD COLUMN gst_rate int CHECK (gst_rate BETWEEN 0 AND 10000),
  ADD COLUMN hsn text;
ALTER TABLE vouchers ADD COLUMN gst jsonb;
