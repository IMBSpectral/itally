-- Companies, the chart of groups and ledgers, vouchers and their entries.
-- Amounts are bigint paise, + = Debit, - = Credit (see src/engine/money.ts).

CREATE TABLE companies (
  id            serial PRIMARY KEY,
  name          text NOT NULL,
  books_begin   date NOT NULL,             -- first date vouchers may carry
  fy_start      date NOT NULL,             -- start of the current financial year
  state         text,
  gstin         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE groups (
  id                    serial PRIMARY KEY,
  company_id            int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name                  text NOT NULL,
  parent_id             int REFERENCES groups(id),
  nature                text NOT NULL CHECK (nature IN ('Assets','Liabilities','Income','Expenses')),
  affects_gross_profit  boolean NOT NULL DEFAULT false,
  is_default            boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX groups_name ON groups (company_id, lower(name));

CREATE TABLE ledgers (
  id          serial PRIMARY KEY,
  company_id  int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        text NOT NULL,
  group_id    int REFERENCES groups(id),   -- null only for the primary Profit & Loss A/c
  opening     bigint NOT NULL DEFAULT 0,
  is_default  boolean NOT NULL DEFAULT false,
  gstin       text,
  state       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ledgers_name ON ledgers (company_id, lower(name));

CREATE TABLE vouchers (
  id          serial PRIMARY KEY,
  company_id  int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type        text NOT NULL CHECK (type IN ('Contra','Payment','Receipt','Journal','Sales','Purchase','Credit Note','Debit Note')),
  number      int NOT NULL,
  date        date NOT NULL,
  narration   text NOT NULL DEFAULT '',
  cancelled   boolean NOT NULL DEFAULT false,
  version     int NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, type, number)
);
CREATE INDEX vouchers_daybook ON vouchers (company_id, date, id);

-- Next voucher number per company and type; an upsert takes a lock on one row only.
CREATE TABLE voucher_counters (
  company_id  int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type        text NOT NULL,
  last        int NOT NULL,
  PRIMARY KEY (company_id, type)
);

CREATE TABLE entries (
  id          bigserial PRIMARY KEY,
  voucher_id  int NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  line        int NOT NULL,
  ledger_id   int NOT NULL REFERENCES ledgers(id),
  amount      bigint NOT NULL CHECK (amount <> 0),
  UNIQUE (voucher_id, line)
);
CREATE INDEX entries_ledger ON entries (ledger_id);

-- Running totals per ledger per day, kept current by trigger in the posting transaction.
-- A balance "as on" any date is opening + the sum of at most one row per active day,
-- so reports never re-scan the entries table.
CREATE TABLE ledger_daily (
  ledger_id  int NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  day        date NOT NULL,
  dr         bigint NOT NULL DEFAULT 0,
  cr         bigint NOT NULL DEFAULT 0,   -- stored positive
  PRIMARY KEY (ledger_id, day)
);

-- Closing stock valuations for Stock-in-Hand ledgers (accounts-only mode).
CREATE TABLE stock_values (
  ledger_id  int NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  as_of      date NOT NULL,
  value      bigint NOT NULL,
  PRIMARY KEY (ledger_id, as_of)
);

-- ---------------------------------------------------------------- triggers

-- Keep ledger_daily in step with entries.
CREATE FUNCTION entries_daily() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d date;
BEGIN
  IF TG_OP IN ('DELETE','UPDATE') THEN
    SELECT date INTO d FROM vouchers WHERE id = OLD.voucher_id;
    IF d IS NOT NULL THEN   -- null when the voucher row itself is being deleted (cascade)
      UPDATE ledger_daily SET dr = dr - GREATEST(OLD.amount, 0), cr = cr - GREATEST(-OLD.amount, 0)
       WHERE ledger_id = OLD.ledger_id AND day = d;
    END IF;
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
    SELECT date INTO d FROM vouchers WHERE id = NEW.voucher_id;
    INSERT INTO ledger_daily (ledger_id, day, dr, cr)
         VALUES (NEW.ledger_id, d, GREATEST(NEW.amount, 0), GREATEST(-NEW.amount, 0))
    ON CONFLICT (ledger_id, day) DO UPDATE
         SET dr = ledger_daily.dr + EXCLUDED.dr, cr = ledger_daily.cr + EXCLUDED.cr;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER entries_daily AFTER INSERT OR UPDATE OR DELETE ON entries
  FOR EACH ROW EXECUTE FUNCTION entries_daily();

-- Deleting a voucher cascades to entries after the voucher row is gone, so take its
-- entries out of ledger_daily first, while the date is still readable.
CREATE FUNCTION vouchers_before_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE ledger_daily ld SET dr = ld.dr - x.dr, cr = ld.cr - x.cr
    FROM (SELECT ledger_id, SUM(GREATEST(amount,0)) dr, SUM(GREATEST(-amount,0)) cr
            FROM entries WHERE voucher_id = OLD.id GROUP BY ledger_id) x
   WHERE ld.ledger_id = x.ledger_id AND ld.day = OLD.date;
  RETURN OLD;
END $$;
CREATE TRIGGER vouchers_before_delete BEFORE DELETE ON vouchers
  FOR EACH ROW EXECUTE FUNCTION vouchers_before_delete();

-- A voucher's date can't move while it has entries (the API replaces entries on alter).
CREATE FUNCTION vouchers_date_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.date <> OLD.date AND EXISTS (SELECT 1 FROM entries WHERE voucher_id = OLD.id) THEN
    RAISE EXCEPTION 'voucher % date changed while it has entries', OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vouchers_date_guard BEFORE UPDATE OF date ON vouchers
  FOR EACH ROW EXECUTE FUNCTION vouchers_date_guard();

-- Entries must use the voucher's own company's ledgers.
CREATE FUNCTION entries_same_company() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT company_id FROM vouchers WHERE id = NEW.voucher_id)
     IS DISTINCT FROM (SELECT company_id FROM ledgers WHERE id = NEW.ledger_id) THEN
    RAISE EXCEPTION 'ledger % belongs to another company', NEW.ledger_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER entries_same_company BEFORE INSERT OR UPDATE ON entries
  FOR EACH ROW EXECUTE FUNCTION entries_same_company();

-- Double entry, checked at COMMIT: every live voucher has >= 2 entries summing to zero;
-- a cancelled voucher keeps its number but has no entries.
CREATE FUNCTION voucher_balance_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE vid int; n int; total bigint; is_cancelled boolean;
BEGIN
  -- separate branches: PL/pgSQL resolves record fields even in untaken CASE arms
  IF TG_TABLE_NAME = 'vouchers' THEN vid := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN vid := OLD.voucher_id;
  ELSE vid := NEW.voucher_id;
  END IF;
  SELECT cancelled INTO is_cancelled FROM vouchers WHERE id = vid;
  IF NOT FOUND THEN RETURN NULL; END IF;   -- voucher deleted in this transaction
  SELECT count(*), COALESCE(SUM(amount), 0) INTO n, total FROM entries WHERE voucher_id = vid;
  IF is_cancelled THEN
    IF n > 0 THEN RAISE EXCEPTION 'cancelled voucher % still has entries', vid; END IF;
  ELSIF n < 2 OR total <> 0 THEN
    RAISE EXCEPTION 'voucher % is not balanced (entries %, difference %)', vid, n, total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER entries_balanced AFTER INSERT OR UPDATE OR DELETE ON entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION voucher_balance_check();
CREATE CONSTRAINT TRIGGER vouchers_balanced AFTER INSERT OR UPDATE ON vouchers
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION voucher_balance_check();
