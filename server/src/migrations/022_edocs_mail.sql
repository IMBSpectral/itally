-- e-Invoice, e-Way Bill and e-mail.
--
-- The company gets the mailing details a seller block needs (printed invoices, e-Invoice and
-- e-Way Bill JSON). A unit can name its GST unit quantity code (UQC) when its symbol isn't one.
--
-- e_documents holds what the portals give back for a voucher: the IRN with its acknowledgement and
-- signed QR code, and the e-Way Bill number with its validity, plus the transport details the
-- e-Way Bill is made with. Without GSP credentials the JSON is uploaded on the portals by hand and
-- their answer typed (or pasted) back here.
--
-- mail_settings is the company's SMTP server; mail_log records every message sent or refused.

ALTER TABLE companies
  ADD COLUMN mailing_name text,
  ADD COLUMN address text,
  ADD COLUMN pincode text,
  ADD COLUMN phone text,
  ADD COLUMN email text;

ALTER TABLE units ADD COLUMN uqc text CHECK (uqc IS NULL OR uqc ~ '^[A-Z]{3}$');

CREATE TABLE e_documents (
  voucher_id      int PRIMARY KEY REFERENCES vouchers(id) ON DELETE CASCADE,
  irn             text CHECK (irn IS NULL OR irn ~ '^[0-9a-f]{64}$'),
  ack_no          text,
  ack_date        text,
  signed_qr       text,
  irn_cancelled   boolean NOT NULL DEFAULT false,
  ewb_no          text CHECK (ewb_no IS NULL OR ewb_no ~ '^[0-9]{12}$'),
  ewb_date        text,
  ewb_valid_upto  text,
  transport       jsonb,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mail_settings (
  company_id   int PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  host         text NOT NULL,
  port         int NOT NULL CHECK (port BETWEEN 1 AND 65535),
  secure       boolean NOT NULL DEFAULT false,   -- TLS from the start (465); otherwise STARTTLS when offered
  username     text,
  password     text,
  from_address text NOT NULL,
  from_name    text
);

CREATE TABLE mail_log (
  id          bigserial PRIMARY KEY,
  company_id  int NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT now(),
  recipient   text NOT NULL,
  subject     text NOT NULL,
  voucher_id  int REFERENCES vouchers(id) ON DELETE SET NULL,
  error       text                                -- null: sent
);
CREATE INDEX mail_log_company ON mail_log (company_id, at DESC);
