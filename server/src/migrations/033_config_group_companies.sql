-- F12 Configuration: a company's choices for how vouchers are entered and reports shown.
ALTER TABLE companies ADD COLUMN config jsonb NOT NULL DEFAULT '{}';

-- A group company, as Tally's: its members' books shown together (consolidated Trial Balance,
-- Profit & Loss and Balance Sheet). It keeps no books of its own.
CREATE TABLE group_companies (
  id       serial PRIMARY KEY,
  name     text NOT NULL,
  members  int[] NOT NULL CHECK (cardinality(members) >= 2)
);
CREATE UNIQUE INDEX group_companies_name ON group_companies (lower(name));
