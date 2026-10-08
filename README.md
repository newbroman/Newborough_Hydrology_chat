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
- rate-limits each visitor (10 questions an hour, 30 a day) by a salted hash of the
  IP address that is never logged and is deleted after two days;
- logs each question with its answer, citations, language, cost and warning flags,
  kept for 365 days. No IP address, user agent or other identifier is stored.

When the cap is reached or the Worker is unavailable, the page falls back to
searching the documents.

## Setting it up (once)

Everything below runs on your own machine, in a clone of this repository. You
type the API key into the terminal prompt only, never into a chat or a file.

1. **API key.** At [platform.claude.com](https://platform.claude.com), create an
   API key for this bot. Under *Limits*, set a monthly usage limit a little above
   the Worker's cap (the Worker stops first; this is the backstop).
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

Writes `exports/chat_log_<month>.csv` (git-ignored) and prints a summary:
questions, languages, flags and spend.

## Changing things

| To change | Edit |
|---|---|
| Monthly cap, rate limits, retention | `[vars]` in `wrangler.toml`, then `npx wrangler deploy` |
| Rules, tools, model, answer length | `tools/chat_rules.md`, `tools/chat_tools.json`, `tools/chat_public.json` in Newborough_Hydrology, then ship |
| Prices (when Anthropic changes them) | `PRICES` in `src/index.js`, then test and deploy |

A model not listed in `PRICES` is refused, so the cap cannot be bypassed by a
config change.

## Tests

`npm test` runs the Worker against a real SQLite database and a mocked Claude API:
metering, the daily share and monthly cap, rate limits, origin and input
refusals, the forced final round, citation flags, retention.
