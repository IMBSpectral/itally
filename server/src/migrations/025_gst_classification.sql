-- GST Classification: an HSN/SAC with its rate and taxability, kept once and picked on stock items
-- and ledgers, as in Tally. Changing a classification's rate changes the invoices entered after it;
-- posted invoices keep the breakup they were saved with. An item or ledger without a classification
-- keeps its own HSN, rate and (new here) taxability: Exempt, Nil Rated and Non-GST supplies are
-- reported apart from taxable ones (GSTR-1 table 8, GSTR-3B 3.1(c)/(e) and 5).
CREATE TABLE gst_classifications (
  id          serial PRIMARY KEY,
  company_id  int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        text NOT NULL,
  hsn         text,
  description text,
  taxability  text NOT NULL DEFAULT 'Taxable' CHECK (taxability IN ('Taxable', 'Exempt', 'Nil Rated', 'Non-GST')),
  gst_rate    int CHECK (gst_rate BETWEEN 0 AND 10000),
  CHECK (taxability = 'Taxable' OR COALESCE(gst_rate, 0) = 0)
);
CREATE UNIQUE INDEX gst_classifications_name ON gst_classifications (company_id, lower(name));

ALTER TABLE ledgers
  ADD COLUMN gst_classification_id int REFERENCES gst_classifications(id),
  ADD COLUMN taxability text CHECK (taxability IN ('Taxable', 'Exempt', 'Nil Rated', 'Non-GST'));
ALTER TABLE stock_items
  ADD COLUMN gst_classification_id int REFERENCES gst_classifications(id),
  ADD COLUMN taxability text CHECK (taxability IN ('Taxable', 'Exempt', 'Nil Rated', 'Non-GST'));

-- The Edit Log records the masters added since 014: voucher types and stock categories (023) and
-- GST classifications. Copied from 016, the latest definition.
ALTER TABLE edit_log DROP CONSTRAINT edit_log_entity_check;
ALTER TABLE edit_log ADD CONSTRAINT edit_log_entity_check
  CHECK (entity IN ('voucher', 'ledger', 'group', 'company', 'stock item', 'stock group', 'unit', 'godown', 'cost category', 'cost centre',
                    'voucher type', 'stock category', 'GST classification'));

CREATE OR REPLACE FUNCTION log_master_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; kind text; cid int; j jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  j := to_jsonb(r);
  kind := CASE TG_TABLE_NAME WHEN 'ledgers' THEN 'ledger' WHEN 'groups' THEN 'group' WHEN 'stock_items' THEN 'stock item'
               WHEN 'stock_groups' THEN 'stock group' WHEN 'units' THEN 'unit' WHEN 'godowns' THEN 'godown'
               WHEN 'cost_categories' THEN 'cost category' WHEN 'cost_centres' THEN 'cost centre'
               WHEN 'voucher_types' THEN 'voucher type' WHEN 'stock_categories' THEN 'stock category'
               WHEN 'gst_classifications' THEN 'GST classification' ELSE 'company' END;
  cid := CASE WHEN kind = 'company' THEN (j ->> 'id')::int ELSE (j ->> 'company_id')::int END;
  INSERT INTO edit_log (company_id, entity, entity_id, action, label, data)
  VALUES (cid, kind, (j ->> 'id')::int, CASE TG_OP WHEN 'INSERT' THEN 'create' WHEN 'UPDATE' THEN 'alter' ELSE 'delete' END,
          COALESCE(j ->> 'symbol', j ->> 'name'), j - 'company_id');
  RETURN NULL;
END $$;

CREATE TRIGGER voucher_types_edit_log AFTER INSERT OR UPDATE OR DELETE ON voucher_types FOR EACH ROW EXECUTE FUNCTION log_master_change();
CREATE TRIGGER stock_categories_edit_log AFTER INSERT OR UPDATE OR DELETE ON stock_categories FOR EACH ROW EXECUTE FUNCTION log_master_change();
CREATE TRIGGER gst_classifications_edit_log AFTER INSERT OR UPDATE OR DELETE ON gst_classifications FOR EACH ROW EXECUTE FUNCTION log_master_change();
