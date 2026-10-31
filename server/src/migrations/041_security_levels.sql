-- Security levels of the company's own, as Tally's: built on a role (Accountant, Data Entry or
-- Viewer), they take away voucher types and reports, and may limit how far back a voucher is dated.
CREATE TABLE security_levels (
  id               serial PRIMARY KEY,
  company_id       int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name             text NOT NULL,
  base_role        text NOT NULL CHECK (base_role IN ('Accountant', 'Data Entry', 'Viewer')),
  denied_vouchers  text[] NOT NULL DEFAULT '{}',
  denied_reports   text[] NOT NULL DEFAULT '{}',
  back_days        int CHECK (back_days >= 0)
);
CREATE UNIQUE INDEX security_levels_name ON security_levels (company_id, lower(name));

-- a user with a level has its base role, less what the level takes away
ALTER TABLE users ADD COLUMN level_id int REFERENCES security_levels(id);
