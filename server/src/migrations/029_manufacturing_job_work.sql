-- Manufacturing and job work, as in Tally. A stock item may have a bill of materials (what one
-- batch of it is made from). A Manufacturing Journal consumes the components and makes the item,
-- which takes their cost plus any additional cost (labour, power). Rejections In and Out take back
-- goods a customer rejected and return goods to a supplier. Job work: a Job Work Out Order asks a
-- job worker to process goods for us, Material Out sends them the materials (into a godown that
-- is our stock with a third party) and Material In brings the finished goods back (consuming the
-- materials there). A Job Work In Order is the other way round: a principal's materials come in
-- by Material In to a godown that is a third party's stock with us, which is not our stock and
-- does not count in our valuation, and go back out by Material Out.

ALTER TABLE godowns ADD COLUMN third_party text CHECK (third_party IN ('ours', 'theirs'));  -- 'ours': our stock with a third party; 'theirs': a third party's stock with us

CREATE TABLE boms (
  item_id     int PRIMARY KEY REFERENCES stock_items(id) ON DELETE CASCADE,
  makes_qty   bigint NOT NULL CHECK (makes_qty > 0),        -- thousandths of the item's unit one batch makes
  components  jsonb NOT NULL                                 -- [{ itemId, qty (thousandths) }]
);

ALTER TABLE vouchers ADD COLUMN additional_cost bigint NOT NULL DEFAULT 0 CHECK (additional_cost >= 0);

ALTER TABLE vouchers DROP CONSTRAINT vouchers_type_check;
ALTER TABLE vouchers ADD CONSTRAINT vouchers_type_check CHECK (type IN (
  'Contra', 'Payment', 'Receipt', 'Journal', 'Sales', 'Purchase', 'Credit Note', 'Debit Note',
  'Sales Order', 'Purchase Order', 'Delivery Note', 'Receipt Note', 'Stock Journal', 'Physical Stock', 'Memorandum', 'Payroll', 'Attendance',
  'Manufacturing Journal', 'Rejections In', 'Rejections Out', 'Material In', 'Material Out', 'Job Work In Order', 'Job Work Out Order'));
ALTER TABLE voucher_types DROP CONSTRAINT voucher_types_base_type_check;
ALTER TABLE voucher_types ADD CONSTRAINT voucher_types_base_type_check CHECK (base_type IN (
  'Contra', 'Payment', 'Receipt', 'Journal', 'Sales', 'Purchase', 'Credit Note', 'Debit Note',
  'Sales Order', 'Purchase Order', 'Delivery Note', 'Receipt Note', 'Stock Journal', 'Physical Stock', 'Memorandum', 'Payroll', 'Attendance',
  'Manufacturing Journal', 'Rejections In', 'Rejections Out', 'Material In', 'Material Out', 'Job Work In Order', 'Job Work Out Order'));

-- Double entry at COMMIT; the new inventory vouchers have no ledger entries (copied from 028).
CREATE OR REPLACE FUNCTION voucher_balance_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE vid int; n int; total bigint; is_cancelled boolean; vtype text; is_draft boolean;
BEGIN
  IF voucher_batch() THEN RETURN NULL; END IF;   -- close_voucher_batch checks the whole batch
  IF TG_TABLE_NAME = 'vouchers' THEN vid := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN vid := OLD.voucher_id;
  ELSE vid := NEW.voucher_id;
  END IF;
  SELECT cancelled, type, optional OR type = 'Memorandum' INTO is_cancelled, vtype, is_draft FROM vouchers WHERE id = vid;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*), COALESCE(SUM(amount), 0) INTO n, total FROM entries WHERE voucher_id = vid;
  IF is_cancelled OR is_draft THEN
    IF n > 0 THEN RAISE EXCEPTION 'voucher % is out of the books but still has entries', vid; END IF;
  ELSIF vtype IN ('Sales Order', 'Purchase Order', 'Delivery Note', 'Receipt Note', 'Stock Journal', 'Physical Stock', 'Attendance',
                  'Manufacturing Journal', 'Rejections In', 'Rejections Out', 'Material In', 'Material Out', 'Job Work In Order', 'Job Work Out Order') THEN
    IF n > 0 THEN RAISE EXCEPTION 'a % has no ledger entries', vtype USING ERRCODE = 'check_violation'; END IF;
  ELSIF n < 2 OR total <> 0 THEN
    RAISE EXCEPTION 'voucher % is not balanced (entries %, difference %)', vid, n, total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
