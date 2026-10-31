-- Compound units, as in Tally: "Box of 12 Nos" is a first unit (Box), a conversion (12) and a
-- second unit (Nos). Quantities of an item in a compound unit are kept in the second unit, so
-- every sum and valuation stays as it is; screens show them as "2 Box 5 Nos" and take "2-5".
-- A compound unit's decimals are its second unit's.
ALTER TABLE units
  ADD COLUMN first_unit_id int REFERENCES units(id) DEFERRABLE INITIALLY DEFERRED,
  ADD COLUMN second_unit_id int REFERENCES units(id) DEFERRABLE INITIALLY DEFERRED,
  ADD COLUMN conversion int CHECK (conversion > 1),
  ADD CONSTRAINT units_compound_check CHECK (
    (first_unit_id IS NULL AND second_unit_id IS NULL AND conversion IS NULL) OR
    (first_unit_id IS NOT NULL AND second_unit_id IS NOT NULL AND conversion IS NOT NULL AND first_unit_id <> second_unit_id));
