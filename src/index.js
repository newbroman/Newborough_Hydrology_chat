// Newborough_Hydrology_chat — the Cloudflare Worker behind "Ask Newborough Warren".
//
// A thin, locked proxy between the public chat page and the Claude API. The page
// (served from the Newborough_Hydrology GitHub Pages site) carries the corpus and
// runs the search tools itself; this Worker holds the API key and fixes everything
// that matters: the rules, the tool definitions, the model and the limits (fetched
// from the site's chat/chat_config.json, built in the analysis repository by
// tools/build_chat_corpus.py), the monthly spending cap, the per-visitor rate limit,
// and the question log.
//
// Spec: claude/NRG_spec_chatbot_public_2026-10-08.md (Martin, 2026-10-08: log what
// is asked; GBP 10 a month; the stronger model for everyone; 12 months' retention).
//
// VERSION 1.0.1 - 2026-10-09
//   1.0.1: an account spend limit reached at Anthropic (the Console limit, HTTP 400
//     "You have reached your specified API usage limits", or the tier cap, HTTP 429
//     enforced_spend_limit_reached) now answers budget_exhausted, so the page falls
//     back to search; it had answered upstream_error / rate_limited.
//     An exhausted prepaid credit balance ("credit balance is too low") is treated the same.

export const VERSION = "1.0.1";

// USD per million tokens. Published prices (platform.claude.com/docs/en/about-claude/pricing,
// read 2026-10-08). Cache writes are charged at 1.25x input (5-minute cache).
// A model not listed here is refused, so a changed config cannot switch to an unpriced model.
export const PRICES = {
  "claude-opus-5-5":   { in: 4, out: 20, cache_read: 0.20, cache_write: 5.0 },
  "claude-sonnet-5-5": { in: 2, out: 10, cache_read: 0.10, cache_write: 2.5 },
};

const API_URL = "https://api.anthropic.com/v1/messages";
const CONFIG_TTL_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 250_000;

let configCache = null; // {at, cfg}

// ------------------------------------------------------------------ helpers
function json(body, status = 200, origin = "") {
  const h = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
  if (origin) { h["access-control-allow-origin"] = origin; h["vary"] = "Origin"; }
  return new Response(JSON.stringify(body), { status, headers: h });
}
function fail(code, status, origin, message = "") { return json({ code, message }, status, origin); }

function allowedOrigin(env, origin) {
  const list = String(env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  return list.includes(origin) ? origin : "";
}

export function costUSD(model, u) {
  const p = PRICES[model];
  if (!p || !u) return 0;
  const m = 1e6;
  return (u.input_tokens || 0) * p.in / m
       + (u.output_tokens || 0) * p.out / m
       + (u.cache_read_input_tokens || 0) * p.cache_read / m
       + (u.cache_creation_input_tokens || 0) * p.cache_write / m;
}

function monthKey(d) { return d.toISOString().slice(0, 7); }
function dayKey(d) { return d.toISOString().slice(0, 10); }
function daysInMonth(d) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); }

// Monthly cap in USD, and the share of it allowed by today (unspent days roll over).
export function allowance(env, now) {
  const capUSD = Number(env.MONTHLY_CAP_GBP || 10) / Number(env.GBP_PER_USD || 0.8);
  const toDate = capUSD * now.getUTCDate() / daysInMonth(now);
  return { capUSD, toDate };
}

async function sha256hex(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}

export function detectLanguage(q) {
  const s = " " + q.toLowerCase() + " ";
  if (/[ąęłńśźż]/.test(s) || /\s(jak|czy|jest|gdzie|dlaczego|ile|co)\s/.test(s)) return "pl";
  if (/[ŵŷ]/.test(s) || /\s(beth|sut|pam|ydy|yw|mae|dŵr|ble|faint)\s/.test(s)) return "cy";
  if (/\s(the|what|how|why|is|are|does|which)\s/.test(s)) return "en";
  return "other";
}

// ------------------------------------------------------------------ config
async function getConfig(env, fetchImpl) {
  const now = Date.now();
  if (configCache && now - configCache.at < CONFIG_TTL_MS) return configCache.cfg;
  const r = await fetchImpl(env.CONFIG_URL, { cf: { cacheTtl: 300 } });
  if (!r.ok) throw new Error(`config ${r.status}`);
  const cfg = await r.json();
  if (!cfg.rules || !Array.isArray(cfg.tools) || !PRICES[cfg.model]) throw new Error("config invalid");
  configCache = { at: now, cfg };
  return cfg;
}
export function _resetConfigCache() { configCache = null; }

// ------------------------------------------------------------------ validation
// The conversation since the visitor's latest question: that question, then any
// assistant tool_use / user tool_result pairs. Earlier turns are plain text history.
export function analyse(messages, cfg) {
  if (!Array.isArray(messages) || !messages.length) return { error: "no messages" };
  let expect = "user";
  for (const m of messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) return { error: "bad role" };
    if (m.role !== expect) return { error: "roles must alternate, starting with user" };
    expect = m.role === "user" ? "assistant" : "user";
    if (typeof m.content === "string") continue;
    if (!Array.isArray(m.content)) return { error: "bad content" };
    for (const b of m.content) {
      if (!b || !["text", "tool_use", "tool_result"].includes(b.type)) return { error: "bad block" };
      if (b.type === "tool_use" && m.role !== "assistant") return { error: "tool_use from user" };
      if (b.type === "tool_result" && m.role !== "user") return { error: "tool_result from assistant" };
    }
  }
  if (messages[messages.length - 1].role !== "user") return { error: "must end with user" };
  // The latest question is the last user turn whose content is a string.
  let qi = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && typeof messages[i].content === "string") { qi = i; break; }
  }
  if (qi < 0) return { error: "no question" };
  const qText = messages[qi].content;
  const marker = qText.lastIndexOf("QUESTION:");
  const question = (marker >= 0 ? qText.slice(marker + 9) : qText).trim();
  if (!question) return { error: "empty question" };
  if (question.length > cfg.max_question_chars) return { error: "too_long" };
  const history = messages.slice(0, qi);
  if (history.length > cfg.max_history_turns) return { error: "history too long" };
  if (history.some(m => typeof m.content !== "string")) return { error: "history must be plain text" };
  const rounds = messages.slice(qi).filter(m => m.role === "assistant").length;
  if (rounds > cfg.max_rounds) return { error: "too many rounds" };
  // Ids the answer may cite: everything that came back from the page's searches.
  const after = JSON.stringify(messages.slice(qi));
  const retrieved = new Set([...after.matchAll(/\\?"id\\?":\\?"([dnr]\d+)\\?"/g)].map(x => x[1]));
  if (/cluster_summary/.test(after)) retrieved.add("f:outputs/02_cluster_stats.csv");
  return { question, rounds, isNewQuestion: rounds === 0, retrieved };
}

export function citations(text) {
  const ids = [];
  for (const m of String(text).matchAll(/\[\[([^\]]+)\]\]/g)) {
    for (const id of m[1].split(/[,\s]+/).filter(Boolean)) ids.push(id);
  }
  return [...new Set(ids)];
}

// ------------------------------------------------------------------ storage
async function spentThisMonth(db, month) {
  const r = await db.prepare("SELECT usd FROM spend WHERE month = ?").bind(month).first();
  return r ? Number(r.usd) : 0;
}

async function rateCheck(db, env, ip, now) {
  const salt = env.IP_SALT || "";
  const key = await sha256hex(`${salt}|${dayKey(now)}|${ip}`);
  const day = dayKey(now), hour = now.toISOString().slice(0, 13);
  const row = await db.prepare("SELECT day, hour, n_day, n_hour FROM rate WHERE key = ?").bind(key).first();
  let nDay = 0, nHour = 0;
  if (row && row.day === day) { nDay = row.n_day; nHour = row.hour === hour ? row.n_hour : 0; }
  if (nHour >= Number(env.RATE_PER_HOUR || 10) || nDay >= Number(env.RATE_PER_DAY || 30)) return false;
  await db.prepare(
    "INSERT INTO rate (key, day, hour, n_day, n_hour) VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT(key) DO UPDATE SET day = excluded.day, hour = excluded.hour, " +
    "n_day = excluded.n_day, n_hour = excluded.n_hour"
  ).bind(key, day, hour, nDay + 1, nHour + 1).run();
  return true;
}

// ------------------------------------------------------------------ handlers
async function handleStatus(env, origin, fetchImpl, now) {
  let available = !!env.ANTHROPIC_API_KEY, reason = available ? "" : "not configured";
  try { await getConfig(env, fetchImpl); } catch (e) { available = false; reason = "config"; }
  if (available) {
    const { toDate } = allowance(env, now);
    if (await spentThisMonth(env.DB, monthKey(now)) >= toDate) { available = false; reason = "budget"; }
  }
  return json({ available, reason, version: VERSION }, 200, origin);
}

async function handleAsk(request, env, origin, fetchImpl, now) {
  if (!env.ANTHROPIC_API_KEY) return fail("unavailable", 503, origin, "not configured");
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return fail("prompt_too_large", 413, origin);
  let body;
  try { body = JSON.parse(raw); } catch { return fail("bad_request", 400, origin, "not JSON"); }
  const qid = String(body.qid || "").slice(0, 64);
  if (!/^[\w.-]{6,64}$/.test(qid)) return fail("bad_request", 400, origin, "qid");

  let cfg;
  try { cfg = await getConfig(env, fetchImpl); } catch { return fail("unavailable", 503, origin, "config"); }
  const a = analyse(body.messages, cfg);
  if (a.error === "too_long") return fail("too_long", 400, origin);
  if (a.error) return fail("bad_request", 400, origin, a.error);

  const month = monthKey(now);
  const spent = await spentThisMonth(env.DB, month);
  const { capUSD, toDate } = allowance(env, now);
  // A new question needs today's share; a question already under way may finish
  // on the month's remainder, so nobody is left with half an answer.
  if (a.isNewQuestion ? spent >= toDate : spent >= capUSD) return fail("budget_exhausted", 503, origin);
  if (a.isNewQuestion) {
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    if (!(await rateCheck(env.DB, env, ip, now))) return fail("rate_limited", 429, origin);
  }

  const tools = cfg.tools.map((t, i) => i === cfg.tools.length - 1
    ? { ...t, cache_control: { type: "ephemeral" } } : t);
  const req = {
    model: cfg.model,
    max_tokens: cfg.max_tokens,
    system: [{ type: "text", text: cfg.rules, cache_control: { type: "ephemeral" } }],
    tools,
    messages: body.messages,
  };
  // The last permitted round must answer: no further tool calls.
  if (a.rounds >= cfg.max_rounds) req.tool_choice = { type: "none" };

  let r, j;
  try {
    r = await fetchImpl(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY,
                 "anthropic-version": "2023-06-01" },
      body: JSON.stringify(req),
    });
    j = await r.json();
  } catch { return fail("upstream_error", 502, origin); }
  if (!r.ok) {
    const t = j && j.error && j.error.type;
    const msg = String(j && j.error && j.error.message || "");
    const ecode = j && j.error && j.error.details && j.error.details.error_code;
    if (ecode === "enforced_spend_limit_reached" || /reached your specified (workspace )?API usage limits|credit balance is too low/i.test(msg))
      return fail("budget_exhausted", 503, origin);
    if (r.status === 429 || t === "rate_limit_error") return fail("rate_limited", 429, origin);
    return fail(r.status === 529 || r.status >= 500 ? "unavailable" : "upstream_error", 502, origin);
  }

  const cost = costUSD(cfg.model, j.usage);
  const u = j.usage || {};
  const tin = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  const tout = u.output_tokens || 0;
  await env.DB.prepare(
    "INSERT INTO spend (month, usd) VALUES (?, ?) ON CONFLICT(month) DO UPDATE SET usd = usd + excluded.usd"
  ).bind(month, cost).run();
  await env.DB.prepare(
    "INSERT INTO rounds (qid, ts, tokens_in, tokens_out, cost_usd) VALUES (?, ?, ?, ?, ?)"
  ).bind(qid, now.toISOString(), tin, tout, cost).run();

  const finished = j.stop_reason !== "tool_use";
  if (finished) {
    const answer = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    const cited = citations(answer);
    const flags = [];
    if (!cited.length) flags.push("uncited");
    if (cited.some(id => !a.retrieved.has(id))) flags.push("unretrieved_citation");
    if (j.stop_reason === "max_tokens") flags.push("cut_short");
    if (j.stop_reason === "refusal") flags.push("refused");
    if (a.rounds >= cfg.max_rounds) flags.push("round_limit");
    const tot = await env.DB.prepare(
      "SELECT COUNT(*) AS n, SUM(tokens_in) AS tin, SUM(tokens_out) AS tout, SUM(cost_usd) AS usd FROM rounds WHERE qid = ?"
    ).bind(qid).first();
    await env.DB.prepare(
      "INSERT INTO questions (qid, ts, question, lang, answer, citations, rounds, tokens_in, tokens_out, cost_usd, flags, model, corpus) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(qid) DO NOTHING"
    ).bind(qid, now.toISOString().slice(0, 16) + "Z", a.question, detectLanguage(a.question), answer,
           cited.join(" "), tot.n, tot.tin, tot.tout, tot.usd, flags.join(" "), cfg.model,
           String(cfg.corpus_sha256 || "").slice(0, 12)).run();
  }
  return json({ content: j.content, stop_reason: j.stop_reason }, 200, origin);
}

export async function retention(env, now) {
  const days = Number(env.RETENTION_DAYS || 365);
  const cutoff = new Date(now.getTime() - days * 86400_000).toISOString();
  const twoDays = new Date(now.getTime() - 2 * 86400_000);
  await env.DB.prepare("DELETE FROM questions WHERE ts < ?").bind(cutoff).run();
  await env.DB.prepare("DELETE FROM rounds WHERE ts < ?").bind(twoDays.toISOString()).run();
  await env.DB.prepare("DELETE FROM rate WHERE day < ?").bind(dayKey(twoDays)).run();
}

export function makeHandler(fetchImpl = (...a) => fetch(...a), clock = () => new Date()) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      const origin = allowedOrigin(env, request.headers.get("origin") || "");
      if (request.method === "OPTIONS") {
        if (!origin) return new Response(null, { status: 403 });
        return new Response(null, { status: 204, headers: {
          "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST",
          "access-control-allow-headers": "content-type", "access-control-max-age": "86400", "vary": "Origin" } });
      }
      if (!origin) return fail("forbidden", 403, "", "origin");
      try {
        if (url.pathname === "/status" && request.method === "GET") return await handleStatus(env, origin, fetchImpl, clock());
        if (url.pathname === "/ask" && request.method === "POST") return await handleAsk(request, env, origin, fetchImpl, clock());
      } catch (e) {
        return fail("upstream_error", 500, origin);
      }
      return fail("not_found", 404, origin);
    },
    async scheduled(_event, env) { await retention(env, clock()); },
  };
}

export default makeHandler();
