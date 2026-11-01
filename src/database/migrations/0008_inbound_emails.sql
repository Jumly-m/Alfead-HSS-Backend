-- Migration 0008: Inbound email storage for Resend receiving webhooks

CREATE TABLE IF NOT EXISTS inbound_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id VARCHAR(255) UNIQUE NOT NULL,           -- Resend email_id (for dedup)
  message_id VARCHAR(255),                          -- Resend message_id (for threading)
  "from" VARCHAR(512) NOT NULL,                     -- sender name + email
  "to" TEXT[] NOT NULL DEFAULT '{}',                -- recipients
  cc TEXT[] DEFAULT '{}',
  bcc TEXT[] DEFAULT '{}',
  subject TEXT,
  html_body TEXT,                                   -- HTML content (fetched from Resend API)
  text_body TEXT,                                   -- Plain text content
  headers JSONB DEFAULT '{}',
  attachments JSONB DEFAULT '[]',                   -- [{id, filename, content_type, content_disposition, content_id, download_url, expires_at}]
  replied_at TIMESTAMP,                             -- when admin sent a reply
  reply_html TEXT,                                  -- the reply that was sent
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inbound_emails_email_id ON inbound_emails(email_id);
CREATE INDEX IF NOT EXISTS idx_inbound_emails_created_at ON inbound_emails(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbound_emails_from ON inbound_emails("from");
