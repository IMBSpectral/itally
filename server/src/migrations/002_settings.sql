-- Small application settings kept with the data (e.g. which company to reopen on start).
-- Stored in the database rather than the browser, so the desktop app (whose local port
-- changes on every launch) remembers them too.
CREATE TABLE app_settings (
  key    text PRIMARY KEY,
  value  jsonb NOT NULL
);
