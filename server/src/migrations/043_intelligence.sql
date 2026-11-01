-- Intelligence: the review queue's decisions, the assistants (agents) that look over the books on
-- a schedule, and the company's AI settings.

-- A suggestion is found afresh each time; what the user decided about it is kept by its key.
CREATE TABLE ai_review (
  company_id  int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  key         text NOT NULL,
  status      text NOT NULL CHECK (status IN ('dismissed', 'done')),
  at          timestamptz NOT NULL DEFAULT now(),
  by_user     text,
  PRIMARY KEY (company_id, key)
);

-- An assistant: which checks it runs, when, and in which mode. None of them posts, alters or pays:
-- they suggest (into the review queue) or draft (reminders), and a person decides.
CREATE TABLE ai_agents (
  company_id   int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('bank-match', 'collections', 'voucher-review', 'cash-planning')),
  active       boolean NOT NULL DEFAULT false,
  schedule     text NOT NULL DEFAULT 'daily 09:00' CHECK (schedule ~ '^(daily|weekdays) [0-2][0-9]:[0-5][0-9]$'),
  last_run     timestamptz,
  last_result  text,
  PRIMARY KEY (company_id, kind)
);
CREATE TABLE ai_agent_log (
  id          bigserial PRIMARY KEY,
  company_id  int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  at          timestamptz NOT NULL DEFAULT now(),
  result      text NOT NULL
);

-- AI Assist (Ctrl+Space): off until switched on, with the API key it uses (never shown again, never in backups).
CREATE TABLE ai_settings (
  company_id  int PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  enabled     boolean NOT NULL DEFAULT false,
  api_key     text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
