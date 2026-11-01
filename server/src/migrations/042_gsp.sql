-- Generating e-Invoices and e-Way Bills through the government's API, directly (NIC) or through a GSP.
-- gsp_settings holds the company's access: the API addresses, the client id and secret, the
-- e-Invoice and e-Way Bill user names and passwords, the portal's public key, and any headers the
-- GSP adds. The secret and passwords are never sent back to the screens nor put in backups.
CREATE TABLE gsp_settings (
  company_id        int PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  environment       text NOT NULL DEFAULT 'sandbox' CHECK (environment IN ('sandbox', 'production')),
  einvoice_base     text NOT NULL,
  eway_base         text NOT NULL,
  client_id         text NOT NULL,
  client_secret     text NOT NULL,
  einvoice_user     text NOT NULL,
  einvoice_password text NOT NULL,
  eway_user         text,
  eway_password     text,
  public_key        text NOT NULL,          -- PEM: the e-Invoice system's key (the e-Way Bill system's, if different, below)
  eway_public_key   text,
  extra_headers     jsonb NOT NULL DEFAULT '{}',
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- A signed-in session with each system: its token and the session key (SEK), until it expires.
CREATE TABLE gsp_sessions (
  company_id  int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  system      text NOT NULL CHECK (system IN ('einvoice', 'eway')),
  auth_token  text NOT NULL,
  sek         text NOT NULL,                -- base64 of the decrypted 32-byte key
  expires_at  timestamptz NOT NULL,
  PRIMARY KEY (company_id, system)
);

-- Every call made: what was asked, for which voucher, and what came back (errors included).
CREATE TABLE gsp_log (
  id          bigserial PRIMARY KEY,
  company_id  int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT now(),
  system      text NOT NULL,
  action      text NOT NULL,
  voucher_id  int REFERENCES vouchers(id) ON DELETE SET NULL,
  ok          boolean NOT NULL,
  message     text NOT NULL DEFAULT ''
);
CREATE INDEX gsp_log_company ON gsp_log (company_id, at DESC);
