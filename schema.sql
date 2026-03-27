CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  reports_this_month INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);