-- Interest calculation on a ledger, as Tally's "Activate interest calculation": a yearly rate
-- (hundredths of a percent, 1800 = 18% p.a.) on the running balance, or on bills once overdue.
ALTER TABLE ledgers
  ADD COLUMN interest_rate int CHECK (interest_rate BETWEEN 1 AND 100000),
  ADD COLUMN interest_on text NOT NULL DEFAULT 'balance' CHECK (interest_on IN ('balance', 'bills'));
