-- Deleting a company cascades to its ledgers and vouchers in an order Postgres chooses.
-- When the ledgers go first, a voucher's delete trigger would update daily totals of
-- ledgers that no longer exist (and fail their foreign key). Skip those: their totals are
-- being deleted anyway.
CREATE OR REPLACE FUNCTION vouchers_before_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE ledger_daily ld SET dr = ld.dr - x.dr, cr = ld.cr - x.cr
    FROM (SELECT ledger_id, SUM(GREATEST(amount,0)) dr, SUM(GREATEST(-amount,0)) cr
            FROM entries WHERE voucher_id = OLD.id GROUP BY ledger_id) x
   WHERE ld.ledger_id = x.ledger_id AND ld.day = OLD.date
     AND EXISTS (SELECT 1 FROM ledgers l WHERE l.id = x.ledger_id);
  RETURN OLD;
END $$;

-- The links between a company's own rows are checked at commit rather than mid-statement,
-- so deleting a whole company (which removes ledgers, groups and vouchers in one go) works.
-- A ledger or group that is still in use is still refused: the check runs at commit.
ALTER TABLE entries DROP CONSTRAINT entries_ledger_id_fkey,
  ADD CONSTRAINT entries_ledger_id_fkey FOREIGN KEY (ledger_id) REFERENCES ledgers(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE bill_allocations DROP CONSTRAINT bill_allocations_ledger_id_fkey,
  ADD CONSTRAINT bill_allocations_ledger_id_fkey FOREIGN KEY (ledger_id) REFERENCES ledgers(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ledgers DROP CONSTRAINT ledgers_group_id_fkey,
  ADD CONSTRAINT ledgers_group_id_fkey FOREIGN KEY (group_id) REFERENCES groups(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE groups DROP CONSTRAINT groups_parent_id_fkey,
  ADD CONSTRAINT groups_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES groups(id) DEFERRABLE INITIALLY DEFERRED;
