#!/usr/bin/env bash
# export_log.sh - the chatbot's question log and feedback for one month, as CSVs plus a summary.
#   bash scripts/export_log.sh            # this month (UTC)
#   bash scripts/export_log.sh 2026-11
set -euo pipefail
cd "$(dirname "$0")/.."
month="${1:-$(date -u +%Y-%m)}"
[[ "$month" =~ ^[0-9]{4}-[0-9]{2}$ ]] || { echo "month must be YYYY-MM"; exit 1; }
mkdir -p exports
raw="exports/chat_log_${month}.json"
echo "[1/3] reading the log for ${month} from Cloudflare D1 ..."
npx wrangler d1 execute nrg-chat --remote --json \
  --command "SELECT ts, lang, question, answer, citations, rounds, tokens_in, tokens_out, cost_usd, flags, model, corpus FROM questions WHERE ts LIKE '${month}%' ORDER BY ts" \
  > "$raw"
fbraw="exports/chat_feedback_${month}.json"
echo "[2/3] reading the feedback for ${month} ..."
npx wrangler d1 execute nrg-chat --remote --json \
  --command "SELECT f.ts, f.kind, f.text, q.question, q.answer, q.citations FROM feedback f LEFT JOIN questions q ON q.qid = f.qid WHERE f.ts LIKE '${month}%' ORDER BY (f.kind = 'wrong') DESC, f.ts" \
  > "$fbraw"
echo "[3/3] writing CSVs and summary ..."
python3 - "$raw" "exports/chat_log_${month}.csv" "$month" "$fbraw" "exports/chat_feedback_${month}.csv" <<'PY'
import csv, json, sys, collections
raw, out, month, fbraw, fbout = sys.argv[1:]
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
fb = json.load(open(fbraw)); fb = fb[0]["results"] if isinstance(fb, list) else fb["results"]
with open(fbout, "w", newline="", encoding="utf-8") as fh:
    w = csv.DictWriter(fh, fieldnames=list(fb[0].keys()) if fb else ["ts"])
    w.writeheader(); w.writerows(fb)
kinds = collections.Counter(r["kind"] for r in fb)
print(f"  feedback: {dict(kinds) or 'none'}")
for r in [r for r in fb if r["kind"] == "wrong"][:10]:
    print(f"    WRONG {r['ts']}: {(r['text'] or '')[:100]!r}  <- Q: {(r['question'] or '(question not logged)')[:80]!r}")
print(f"  saved {fbout}")
PY
