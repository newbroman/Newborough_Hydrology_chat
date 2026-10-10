-- Worker 1.3.0: the previous question in the same conversation, for reading follow-ups.
-- Run once on a database made before 1.3.0:
--   npx wrangler d1 execute nrg-chat --remote --command "ALTER TABLE questions ADD COLUMN prev_question TEXT"
ALTER TABLE questions ADD COLUMN prev_question TEXT;
