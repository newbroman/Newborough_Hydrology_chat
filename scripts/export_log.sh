#!/usr/bin/env bash
# export_log.sh - the chatbot's question log for one month, as CSV plus a summary.
#   bash scripts/export_log.sh            # this month (UTC)
#   bash scripts/export_log.sh 2026-11
set -euo pipefail
cd "$(dirname "$0")/.."
month="${1:-$(date -u +%Y-%m)}"
[[ "$month" =~ ^[0-9]{4}-[0-9]{2}$ ]] || { echo "month must be YYYY-MM"; exit 1; }
mkdir -p exports
raw="exports/chat_log_${month}.json"
echo "[1/2] reading the log for ${month} from Cloudflare D1 ..."
npx wrangler d1 execute nrg-chat --remote --json \
  --command "SELECT ts, lang, question, answer, citations, rounds, tokens_in, tokens_out, cost_usd, flags, model, corpus FROM questions WHERE ts LIKE '${month}%' ORDER BY ts" \
  > "$raw"
echo "[2/2] writing CSV and summary ..."
python3 - "$raw" "exports/chat_log_${month}.csv" "$month" <<'PY'
import csv, json, sys, collections
raw, out, month = sys.argv[1:]
data = json.load(open(raw))
rows = data[0]["results"] if isinstance(data, list) else data["results"]
with open(out, "w", newline="", encoding="utf-8") as fh:
    w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()) if rows else ["ts"])
    w.writeheader(); w.writerows(rows)
langs = collections.Counter(r["lang"] for r in rows)
flags = collections.Counter(f for r in rows for f in (r["flags"] or "").split())
usd = sum(r["cost_usd"] or 0 for r in rows)
print(f"  {month}: {len(rows)} questions; spend ${usd:.2f}")
print(f"  languages: {dict(langs)}")
print(f"  flags: {dict(flags) or 'none'}")
print(f"  saved {out}")
PY
