-- D1 schema for the Newborough Warren chatbot Worker (src/index.js 1.2.0). Safe to re-run.
-- Apply once: npx wrangler d1 execute nrg-chat --remote --file=schema.sql

-- One row per answered question. No IP address, user agent or any identifier.
CREATE TABLE IF NOT EXISTS questions (
  qid        TEXT PRIMARY KEY,   -- random id made by the page for one question
  ts         TEXT NOT NULL,      -- UTC, to the minute
  question   TEXT NOT NULL,
  lang       TEXT,               -- en / cy / pl / other (heuristic)
  answer     TEXT,
  citations  TEXT,               -- space-separated ids the answer cited
  rounds     INTEGER,
  tokens_in  INTEGER,
  tokens_out INTEGER,
  cost_usd   REAL,
  flags      TEXT,               -- uncited unretrieved_citation cut_short refused round_limit
  model      TEXT,
  corpus     TEXT                -- first 12 hex of the corpus fingerprint
);
CREATE INDEX IF NOT EXISTS questions_ts ON questions (ts);

-- Per-round usage, kept two days, summed into questions when the answer lands.
CREATE TABLE IF NOT EXISTS rounds (
  qid TEXT NOT NULL, ts TEXT NOT NULL,
  tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL
);
CREATE INDEX IF NOT EXISTS rounds_qid ON rounds (qid);

-- The spending meter: USD spent per calendar month (UTC).
CREATE TABLE IF NOT EXISTS spend (month TEXT PRIMARY KEY, usd REAL NOT NULL DEFAULT 0);

-- Rate limiting. key = sha256(salt | day | IP); never written to the log, deleted after two days.
CREATE TABLE IF NOT EXISTS rate (
  key TEXT PRIMARY KEY, day TEXT, hour TEXT, n_day INTEGER, n_hour INTEGER
);

-- Anonymous feedback (1.2.0): one row per "Helpful" / "Something's wrong" / general note.
-- qid ties it to the question it is about (empty for general feedback). No identifier.
CREATE TABLE IF NOT EXISTS feedback (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  ts   TEXT NOT NULL,                -- UTC, to the minute
  qid  TEXT,
  kind TEXT NOT NULL,                -- helpful | wrong | general
  text TEXT
);
CREATE INDEX IF NOT EXISTS feedback_ts ON feedback (ts);
