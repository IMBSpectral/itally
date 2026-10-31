-- TDS (tax deducted at source), as Tally's: the company's TAN; nature-of-payment masters (section,
-- rates, thresholds); party ledgers marked with their deductee type; expense ledgers and TDS duty
-- ledgers (under Duties & Taxes) carrying the nature of payment they book. What is due is worked
-- out from the entries when a report asks, because a threshold depends on everything paid to the
-- party earlier in the year, and earlier vouchers can still change. A payment of TDS keeps its
-- challan (BSR code, serial, date) for Form 26Q.
ALTER TABLE companies
  ADD COLUMN tan text CHECK (tan ~ '^[A-Z]{4}[0-9]{5}[A-Z]$'),
  ADD COLUMN tds_deductor_type text NOT NULL DEFAULT 'Others' CHECK (tds_deductor_type IN ('Government', 'Others')),
  ADD COLUMN tds_responsible text;   -- the person responsible for deducting, as on the return

CREATE TABLE tds_natures (
  id                serial PRIMARY KEY,
  company_id        int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name              text NOT NULL,
  section           text NOT NULL,
  rate_individual   int NOT NULL CHECK (rate_individual BETWEEN 0 AND 10000),   -- hundredths of a percent, individuals and HUFs
  rate_other        int NOT NULL CHECK (rate_other BETWEEN 0 AND 10000),        -- companies, firms and the rest
  rate_no_pan       int NOT NULL CHECK (rate_no_pan BETWEEN 0 AND 10000),       -- section 206AA
  threshold_single  bigint CHECK (threshold_single >= 0),                       -- paise: one payment above it is taxed
  threshold_annual  bigint CHECK (threshold_annual >= 0),                       -- paise: the year's total above it
  excess_only       boolean NOT NULL DEFAULT false                              -- 194Q: tax only the part above the annual limit
);
CREATE UNIQUE INDEX tds_natures_name ON tds_natures (company_id, lower(name));

ALTER TABLE ledgers
  ADD COLUMN tds_nature_id int REFERENCES tds_natures(id),
  ADD COLUMN deductee_type text CHECK (deductee_type IN ('Individual/HUF', 'Company', 'Firm', 'AOP/BOI', 'Others'));

CREATE TABLE tds_challans (
  voucher_id    int PRIMARY KEY REFERENCES vouchers(id) ON DELETE CASCADE,
  bsr_code      text NOT NULL CHECK (bsr_code ~ '^[0-9]{7}$'),
  challan_no    text NOT NULL CHECK (challan_no ~ '^[0-9]{5}$'),
  challan_date  date NOT NULL
);

ALTER TABLE edit_log DROP CONSTRAINT edit_log_entity_check;
ALTER TABLE edit_log ADD CONSTRAINT edit_log_entity_check
  CHECK (entity IN ('voucher', 'ledger', 'group', 'company', 'stock item', 'stock group', 'unit', 'godown', 'cost category', 'cost centre',
                    'voucher type', 'stock category', 'GST classification', 'TDS nature of payment'));

-- copied from 025, the latest definition, adding TDS natures of payment
CREATE OR REPLACE FUNCTION log_master_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; kind text; cid int; j jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  j := to_jsonb(r);
  kind := CASE TG_TABLE_NAME WHEN 'ledgers' THEN 'ledger' WHEN 'groups' THEN 'group' WHEN 'stock_items' THEN 'stock item'
               WHEN 'stock_groups' THEN 'stock group' WHEN 'units' THEN 'unit' WHEN 'godowns' THEN 'godown'
               WHEN 'cost_categories' THEN 'cost category' WHEN 'cost_centres' THEN 'cost centre'
               WHEN 'voucher_types' THEN 'voucher type' WHEN 'stock_categories' THEN 'stock category'
               WHEN 'gst_classifications' THEN 'GST classification' WHEN 'tds_natures' THEN 'TDS nature of payment' ELSE 'company' END;
  cid := CASE WHEN kind = 'company' THEN (j ->> 'id')::int ELSE (j ->> 'company_id')::int END;
  INSERT INTO edit_log (company_id, entity, entity_id, action, label, data)
  VALUES (cid, kind, (j ->> 'id')::int, CASE TG_OP WHEN 'INSERT' THEN 'create' WHEN 'UPDATE' THEN 'alter' ELSE 'delete' END,
          COALESCE(j ->> 'symbol', j ->> 'name'), j - 'company_id');
  RETURN NULL;
END $$;

CREATE TRIGGER tds_natures_edit_log AFTER INSERT OR UPDATE OR DELETE ON tds_natures FOR EACH ROW EXECUTE FUNCTION log_master_change();
