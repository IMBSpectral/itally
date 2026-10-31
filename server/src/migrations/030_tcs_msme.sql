-- TCS (tax collected at source) as Tally's: natures of goods sit beside the natures of payment, told
-- apart by kind. A sales ledger carries a TCS nature and the TCS ledger under Duties & Taxes the same
-- nature; the buyer is marked with its party type (the deductee type column serves both). Form 27EQ
-- reports each collection under its collection code.
ALTER TABLE tds_natures
  ADD COLUMN kind text NOT NULL DEFAULT 'TDS' CHECK (kind IN ('TDS', 'TCS')),
  ADD COLUMN collection_code text CHECK (collection_code ~ '^[A-Z]{1,2}$');

-- MSME details of a party (MSMED Act): the type of enterprise, its Udyam registration and activity.
-- MSME Form 1 lists what is owed to micro and small suppliers beyond 45 days.
CREATE TABLE party_msme (
  ledger_id  int PRIMARY KEY REFERENCES ledgers(id) ON DELETE CASCADE,
  type       text NOT NULL CHECK (type IN ('Micro', 'Small', 'Medium')),
  udyam_no   text CHECK (udyam_no ~ '^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$'),
  activity   text NOT NULL DEFAULT 'Manufacturing' CHECK (activity IN ('Manufacturing', 'Services', 'Trading'))
);
