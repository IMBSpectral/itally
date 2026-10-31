-- Reorder Status: a stock item's reorder level and minimum order quantity (thousandths, in the
-- item's stock unit). Null means not set; the report lists only items that have a reorder level.
ALTER TABLE stock_items
  ADD COLUMN reorder_level bigint CHECK (reorder_level >= 0),
  ADD COLUMN min_order_qty bigint CHECK (min_order_qty >= 0);
