-- A unit is known by its symbol (its formal name is optional), so the Edit Log labels it by symbol.
CREATE OR REPLACE FUNCTION log_master_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; kind text; cid int; j jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  j := to_jsonb(r);
  kind := CASE TG_TABLE_NAME WHEN 'ledgers' THEN 'ledger' WHEN 'groups' THEN 'group' WHEN 'stock_items' THEN 'stock item'
               WHEN 'stock_groups' THEN 'stock group' WHEN 'units' THEN 'unit' WHEN 'godowns' THEN 'godown' ELSE 'company' END;
  cid := CASE WHEN kind = 'company' THEN (j ->> 'id')::int ELSE (j ->> 'company_id')::int END;
  INSERT INTO edit_log (company_id, entity, entity_id, action, label, data)
  VALUES (cid, kind, (j ->> 'id')::int, CASE TG_OP WHEN 'INSERT' THEN 'create' WHEN 'UPDATE' THEN 'alter' ELSE 'delete' END,
          COALESCE(j ->> 'symbol', j ->> 'name'), j - 'company_id');
  RETURN NULL;
END $$;
