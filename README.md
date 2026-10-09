# Newborough_Hydrology_chat

The Cloudflare Worker behind **Ask Newborough Warren**, the chatbot on the
[Newborough Warren hydrology site](https://newbroman.github.io/Newborough_Hydrology/chat/).

The chat page (built in [Newborough_Hydrology](https://github.com/newbroman/Newborough_Hydrology)
by `tools/build_chat_corpus.py`) carries the published corpus and runs the searches in
the visitor's browser. This Worker sits between the page and the Claude API:

- holds the API key (a Cloudflare secret, never in this repository);
- fixes the rules, tool definitions, model and limits, read from the site's
  `chat/chat_config.json`, so the key cannot be used for anything but this bot;
- meters spend from each response's token usage and stops at the monthly cap
  (`MONTHLY_CAP_GBP`, with a daily share so one busy day cannot use the month);
- gives each visitor 5 questions a day (`RATE_PER_DAY`, resetting at 00:00 UTC),
  counted by a salted hash of the IP address that is never logged and is deleted
  after two days. At the limit the page offers the Claude version of the bot, which
  runs on the visitor's own Claude account and starts a fresh conversation;
- logs each question with its answer, citations, language, cost and warning flags,
  kept for 365 days. No IP address, user agent or other identifier is stored.
- takes anonymous feedback on answers ("Helpful", "Something's wrong" with a note) and
  general notes, at most 5 per visitor per day, kept 365 days. Visitors who want a reply
  are pointed to the project's GitHub issues.

When the monthly cap is reached or the Worker is unavailable, the page falls back
to searching the documents.

## Setting it up (once)

Everything below runs on your own machine, in a clone of this repository. You
type the API key into the terminal prompt only, never into a chat or a file.

1. **API key.** At [platform.claude.com](https://platform.claude.com), create an
   API key for this bot (Settings > API keys). Then, under Settings > Billing >
   *Spend limits*, click **Set limit** and enter a monthly limit a little above the
   Worker's cap (the Worker stops first; this is the backstop). If that section is
   missing, the account needs billing set up or the admin role. If the Console limit
   is ever reached first, the Worker treats it like its own cap and the page falls
   back to search.
2. **Cloudflare.** Create a free account at [dash.cloudflare.com](https://dash.cloudflare.com).
3. **Install and sign in:**
   ```bash
   cd ~/projects/Newborough_Hydrology_chat
   npm install
   npx wrangler login
   ```
4. **Database:**
   ```bash
   npx wrangler d1 create nrg-chat
   ```
   Copy the `database_id` it prints into `wrangler.toml`, replacing
   `REPLACE_WITH_ID_FROM_wrangler_d1_create`, then:
   ```bash
   npx wrangler d1 execute nrg-chat --remote --file=schema.sql
   ```
5. **Secrets** (each command prompts for the value):
   ```bash
   npx wrangler secret put ANTHROPIC_API_KEY
   openssl rand -hex 32 | npx wrangler secret put IP_SALT
   ```
6. **Deploy:**
   ```bash
   npm test && npx wrangler deploy
   ```
   It prints the Worker's address, `https://nrg-chat.<your-subdomain>.workers.dev`.
   Put that address in `tools/chat_public.json` (`worker_url`) in
   Newborough_Hydrology; the next ship rebuilds and publishes the page with it.

## Reading the log

```bash
bash scripts/export_log.sh            # this month
bash scripts/export_log.sh 2026-11    # another month
```

Writes `exports/chat_log_<month>.csv` and `exports/chat_feedback_<month>.csv`
(git-ignored) and prints a summary: questions, languages, flags, spend, and the
feedback, answers marked "Something's wrong" first.

## Changing things

| To change | Edit |
|---|---|
| Monthly cap, daily questions per visitor, retention | `[vars]` in `wrangler.toml`, then `npx wrangler deploy` |
| Rules, tools, model, answer length | `tools/chat_rules.md`, `tools/chat_tools.json`, `tools/chat_public.json` in Newborough_Hydrology, then ship |
| Prices (when Anthropic changes them) | `PRICES` in `src/index.js`, then test and deploy |

A model not listed in `PRICES` is refused, so the cap cannot be bypassed by a
config change.

## Tests

`npm test` runs the Worker against a real SQLite database and a mocked Claude API:
metering, the daily share and monthly cap, rate limits, origin and input
refusals, the forced final round, citation flags, retention.
