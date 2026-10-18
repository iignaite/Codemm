-- Emails that unsubscribed, as keyed hashes (never the email), so nobody can
-- put them back on the list by submitting the form.
CREATE TABLE suppressions (
  email_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
