-- Subscribers: the email, whether they agreed to release emails, and when. Nothing else.
-- AUTOINCREMENT so a deleted subscriber's id (inside old unsubscribe links) is never reused.
CREATE TABLE subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  consent INTEGER NOT NULL CHECK (consent IN (0, 1)),
  created_at INTEGER NOT NULL
);

-- Fixed-window rate limits. Keys are keyed hashes, never a raw IP or email.
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
