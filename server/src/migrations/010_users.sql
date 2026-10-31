-- Company security, as in Tally: a company with users asks for a name and password when it is
-- opened, and each user's role decides what they may do. A company without users stays open.
CREATE TABLE users (
  id            serial PRIMARY KEY,
  company_id    int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  username      text NOT NULL CHECK (btrim(username) <> ''),
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('Owner', 'Accountant', 'Data Entry', 'Viewer')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_name ON users (company_id, lower(username));

CREATE TABLE sessions (
  token      text PRIMARY KEY,
  user_id    int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);
