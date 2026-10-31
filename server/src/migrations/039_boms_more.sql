-- Several bills of materials for an item, each by name; each may list by-products, with the
-- share of the cost they take (hundredths of a percent), and scrap.
ALTER TABLE boms DROP CONSTRAINT boms_pkey;
ALTER TABLE boms ADD COLUMN id serial PRIMARY KEY;
ALTER TABLE boms ADD COLUMN name text NOT NULL DEFAULT 'Main';
ALTER TABLE boms ADD COLUMN by_products jsonb NOT NULL DEFAULT '[]';  -- [{ itemId, qty (thousandths), costShare }]
ALTER TABLE boms ADD COLUMN scrap jsonb NOT NULL DEFAULT '[]';        -- [{ itemId, qty (thousandths) }]
CREATE UNIQUE INDEX boms_item_name ON boms (item_id, lower(name));

-- A Manufacturing Journal's line made alongside the main product: a by-product (with the share of
-- the cost it takes) or scrap (valued at its own rate, which comes off the cost of the rest).
ALTER TABLE inventory_entries ADD COLUMN role text CHECK (role IN ('by-product', 'scrap'));
ALTER TABLE inventory_entries ADD COLUMN cost_share int CHECK (cost_share BETWEEN 0 AND 10000);
