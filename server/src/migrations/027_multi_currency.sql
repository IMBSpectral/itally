-- Multi-currency, as Tally's: currency masters, rates of exchange by date (standard, selling and
-- buying), ledgers kept in a foreign currency, and entries on them that carry the foreign amount
-- and the rate it was booked at. The books stay in rupees; the foreign amounts let a report value
-- a ledger (and each of its bills) at a later rate, which is the forex gain or loss.
CREATE TABLE currencies (
  id            serial PRIMARY KEY,
  company_id    int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  symbol        text NOT NULL,                                        -- $, €, USD
  name          text NOT NULL,                                        -- formal name: US Dollar
  decimals      int NOT NULL DEFAULT 2 CHECK (decimals BETWEEN 0 AND 4),
  decimal_name  text                                                  -- cent, for amounts in words
);
CREATE UNIQUE INDEX currencies_symbol ON currencies (company_id, lower(symbol));
CREATE UNIQUE INDEX currencies_name ON currencies (company_id, lower(name));

-- Rupees for one unit of the currency, in ten-thousandths of a rupee (₹83.2500 = 832500).
-- A rate holds from its date until the next one.
CREATE TABLE exchange_rates (
  currency_id  int NOT NULL REFERENCES currencies(id) ON DELETE CASCADE,
  date         date NOT NULL,
  standard     bigint CHECK (standard > 0),   -- for valuing balances
  selling      bigint CHECK (selling > 0),    -- the bank sells the currency to us: payments
  buying       bigint CHECK (buying > 0),     -- the bank buys it from us: receipts
  PRIMARY KEY (currency_id, date),
  CHECK (standard IS NOT NULL OR selling IS NOT NULL OR buying IS NOT NULL)
);

ALTER TABLE ledgers
  ADD COLUMN currency_id int REFERENCES currencies(id),
  ADD COLUMN opening_forex bigint NOT NULL DEFAULT 0;   -- the opening balance in the currency's smallest unit, + Dr

-- The foreign amount of an entry on a foreign-currency ledger, signed like the entry, and the rate it
-- was booked at. A forex adjustment (gain or loss) has a foreign amount of 0 and no rate.
ALTER TABLE entries
  ADD COLUMN forex bigint,
  ADD COLUMN forex_rate bigint CHECK (forex_rate > 0),
  ADD CHECK ((forex IS NULL OR forex = 0) = (forex_rate IS NULL));
-- each bill's share of it
ALTER TABLE bill_allocations ADD COLUMN forex bigint;

ALTER TABLE edit_log DROP CONSTRAINT edit_log_entity_check;
ALTER TABLE edit_log ADD CONSTRAINT edit_log_entity_check
  CHECK (entity IN ('voucher', 'ledger', 'group', 'company', 'stock item', 'stock group', 'unit', 'godown', 'cost category', 'cost centre',
                    'voucher type', 'stock category', 'GST classification', 'TDS nature of payment', 'currency'));

-- copied from 026, the latest definition, adding currencies
CREATE OR REPLACE FUNCTION log_master_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; kind text; cid int; j jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  j := to_jsonb(r);
  kind := CASE TG_TABLE_NAME WHEN 'ledgers' THEN 'ledger' WHEN 'groups' THEN 'group' WHEN 'stock_items' THEN 'stock item'
               WHEN 'stock_groups' THEN 'stock group' WHEN 'units' THEN 'unit' WHEN 'godowns' THEN 'godown'
               WHEN 'cost_categories' THEN 'cost category' WHEN 'cost_centres' THEN 'cost centre'
               WHEN 'voucher_types' THEN 'voucher type' WHEN 'stock_categories' THEN 'stock category'
               WHEN 'gst_classifications' THEN 'GST classification' WHEN 'tds_natures' THEN 'TDS nature of payment'
               WHEN 'currencies' THEN 'currency' ELSE 'company' END;
  cid := CASE WHEN kind = 'company' THEN (j ->> 'id')::int ELSE (j ->> 'company_id')::int END;
  INSERT INTO edit_log (company_id, entity, entity_id, action, label, data)
  VALUES (cid, kind, (j ->> 'id')::int, CASE TG_OP WHEN 'INSERT' THEN 'create' WHEN 'UPDATE' THEN 'alter' ELSE 'delete' END,
          COALESCE(j ->> 'symbol', j ->> 'name'), j - 'company_id');
  RETURN NULL;
END $$;

CREATE TRIGGER currencies_edit_log AFTER INSERT OR UPDATE OR DELETE ON currencies FOR EACH ROW EXECUTE FUNCTION log_master_change();
