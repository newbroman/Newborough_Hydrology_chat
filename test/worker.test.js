// Tests for src/index.js against a real SQLite database (node:sqlite, shaped like D1)
// and a mocked Claude API. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { makeHandler, _resetConfigCache, costUSD, analyse, detectLanguage, retention } from "../src/index.js";

const ORIGIN = "https://newbroman.github.io";
const CONFIG = {
  rules: "RULES", model: "claude-opus-5-5", max_tokens: 1500, max_rounds: 4,
  max_history_turns: 6, max_question_chars: 1000, corpus_sha256: "abc123def4567890",
  tools: [{ name: "search_documents", description: "d", input_schema: { type: "object", properties: {} } },
          { name: "cluster_summary", description: "c", input_schema: { type: "object", properties: {} } }],
};

// A D1-shaped wrapper over node:sqlite.
function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { db.prepare(sql).run(...args); return { success: true }; },
  });
  return { prepare: sql => wrap(sql), raw: db };
}

function envWith(db, extra = {}) {
  return { DB: db, ANTHROPIC_API_KEY: "test-key", IP_SALT: "salt", ALLOWED_ORIGINS: ORIGIN,
           CONFIG_URL: "https://site/chat/chat_config.json", MONTHLY_CAP_GBP: "10", GBP_PER_USD: "0.8",
           RATE_PER_HOUR: "10", RATE_PER_DAY: "30", RETENTION_DAYS: "365", ...extra };
}

// Mock fetch: serves the config, and answers the Claude API from a script.
function mockFetch(script) {
  const calls = [];
  const f = async (url, init) => {
    if (String(url).includes("chat_config.json")) return new Response(JSON.stringify(CONFIG));
    if (String(url).startsWith("https://api.anthropic.com/")) {
      const body = JSON.parse(init.body);
      calls.push({ headers: init.headers, body });
      const next = script.shift();
      return new Response(JSON.stringify(next.body), { status: next.status || 200 });
    }
    throw new Error("unexpected fetch " + url);
  };
  f.calls = calls;
  return f;
}

const usage = { input_tokens: 2000, output_tokens: 300, cache_read_input_tokens: 1500, cache_creation_input_tokens: 0 };
const toolUse = { content: [{ type: "tool_use", id: "tu1", name: "search_documents", input: { queries: ["x"] } }],
                  stop_reason: "tool_use", usage };
const final = { content: [{ type: "text", text: "The water table rises in winter [[d12]] [[n5]]." }],
                stop_reason: "end_turn", usage };

function req(path, { method = "POST", body, origin = ORIGIN, ip = "1.2.3.4" } = {}) {
  const h = { "content-type": "application/json", "cf-connecting-ip": ip };
  if (origin) h.origin = origin;
  return new Request("https://worker" + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
}
const question = (q = "What drives the water table?") =>
  [{ role: "user", content: 'PRE-RETRIEVED:\n{"passages":[{"id":"d12"}],"numbers":[{"id":"n5"}]}\n\nQUESTION: ' + q }];

const NOW = new Date("2026-10-15T12:00:00Z");

test("a question with one tool round is answered, metered and logged", async () => {
  _resetConfigCache();
  const db = d1(), env = envWith(db), f = mockFetch([{ body: toolUse }, { body: final }]);
  const h = makeHandler(f, () => NOW);
  const msgs = question();
  let r = await h.fetch(req("/ask", { body: { qid: "q-000001", messages: msgs } }), env);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("access-control-allow-origin"), ORIGIN);
  let j = await r.json();
  assert.equal(j.stop_reason, "tool_use");
  // The Worker, not the page, supplies the rules, model, tools and caching.
  const sent = f.calls[0].body;
  assert.equal(sent.model, "claude-opus-5-5");
  assert.equal(sent.system[0].text, "RULES");
  assert.deepEqual(sent.system[0].cache_control, { type: "ephemeral" });
  assert.equal(sent.tools.length, 2);
  assert.equal(f.calls[0].headers["x-api-key"], "test-key");
  assert.equal(sent.tool_choice, undefined);
  msgs.push({ role: "assistant", content: j.content },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: '[{"id":"d12"}]' }] });
  r = await h.fetch(req("/ask", { body: { qid: "q-000001", messages: msgs } }), env);
  j = await r.json();
  assert.equal(j.stop_reason, "end_turn");
  const row = db.raw.prepare("SELECT * FROM questions").get();
  assert.equal(row.question, "What drives the water table?");
  assert.equal(row.lang, "en");
  assert.equal(row.rounds, 2);
  assert.equal(row.citations, "d12 n5");
  assert.equal(row.flags, "");
  assert.equal(row.ts, "2026-10-15T12:00Z");
  const one = costUSD("claude-opus-5-5", usage);
  assert.ok(Math.abs(row.cost_usd - 2 * one) < 1e-12);
  const spend = db.raw.prepare("SELECT usd FROM spend WHERE month='2026-10'").get();
  assert.ok(Math.abs(spend.usd - 2 * one) < 1e-12);
  // Nothing identifying is stored.
  const all = JSON.stringify(db.raw.prepare("SELECT * FROM questions").all());
  assert.ok(!all.includes("1.2.3.4"));
});

test("cost arithmetic matches the published prices", () => {
  const c = costUSD("claude-opus-5-5", { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6 });
  assert.equal(c, 4 + 20 + 0.2 + 5);
  assert.equal(costUSD("unknown-model", { input_tokens: 1e6 }), 0);
});

test("uncited and unretrieved citations are flagged", async () => {
  _resetConfigCache();
  const db = d1(), env = envWith(db);
  const bad = { content: [{ type: "text", text: "It is wet [[d99]]." }], stop_reason: "end_turn", usage };
  const none = { content: [{ type: "text", text: "It is wet." }], stop_reason: "end_turn", usage };
  const h = makeHandler(mockFetch([{ body: bad }, { body: none }]), () => NOW);
  await h.fetch(req("/ask", { body: { qid: "q-000002", messages: question() } }), env);
  await h.fetch(req("/ask", { body: { qid: "q-000003", messages: question() } }), env);
  const rows = db.raw.prepare("SELECT qid, flags FROM questions ORDER BY qid").all();
  assert.equal(rows[0].flags, "unretrieved_citation");
  assert.equal(rows[1].flags, "uncited");
});

test("the last permitted round is forced to answer", async () => {
  _resetConfigCache();
  const db = d1(), env = envWith(db), f = mockFetch([{ body: final }]);
  const h = makeHandler(f, () => NOW);
  const msgs = question();
  for (let i = 0; i < 4; i++) {
    msgs.push({ role: "assistant", content: [{ type: "tool_use", id: "t" + i, name: "search_documents", input: {} }] },
              { role: "user", content: [{ type: "tool_result", tool_use_id: "t" + i, content: "[]" }] });
  }
  await h.fetch(req("/ask", { body: { qid: "q-000004", messages: msgs } }), env);
  assert.deepEqual(f.calls[0].body.tool_choice, { type: "none" });
  assert.match(db.raw.prepare("SELECT flags FROM questions").get().flags, /round_limit/);
  // One more round than allowed is refused outright.
  msgs.push({ role: "assistant", content: [{ type: "tool_use", id: "t9", name: "search_documents", input: {} }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "t9", content: "[]" }] });
  const r = await h.fetch(req("/ask", { body: { qid: "q-000005", messages: msgs } }), env);
  assert.equal(r.status, 400);
});

test("the budget stops new questions at today's share, and lets a question in progress finish", async () => {
  _resetConfigCache();
  const db = d1(), env = envWith(db);
  // Day 15 of a 31-day month: today's share of $12.50 is about $6.05.
  db.raw.prepare("INSERT INTO spend VALUES ('2026-10', 6.10)").run();
  const h = makeHandler(mockFetch([{ body: final }]), () => NOW);
  let r = await h.fetch(req("/ask", { body: { qid: "q-000006", messages: question() } }), env);
  assert.equal(r.status, 503);
  assert.equal((await r.json()).code, "budget_exhausted");
  const inProgress = [...question(),
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "search_documents", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "[]" }] }];
  r = await h.fetch(req("/ask", { body: { qid: "q-000007", messages: inProgress } }), env);
  assert.equal(r.status, 200);
  // ...but not past the whole month's cap.
  db.raw.prepare("UPDATE spend SET usd = 12.6").run();
  r = await h.fetch(req("/ask", { body: { qid: "q-000008", messages: inProgress } }), env);
  assert.equal((await r.json()).code, "budget_exhausted");
  // /status reports it.
  r = await h.fetch(req("/status", { method: "GET" }), env);
  assert.deepEqual(await r.json(), { available: false, reason: "budget", version: "1.0.0" });
});

test("rate limit: 10 new questions an hour per visitor; other visitors unaffected", async () => {
  _resetConfigCache();
  const db = d1(), env = envWith(db);
  const script = Array.from({ length: 12 }, () => ({ body: final }));
  const h = makeHandler(mockFetch(script), () => NOW);
  for (let i = 0; i < 10; i++) {
    const r = await h.fetch(req("/ask", { body: { qid: "q-1000" + i, messages: question() } }), env);
    assert.equal(r.status, 200);
  }
  let r = await h.fetch(req("/ask", { body: { qid: "q-100099", messages: question() } }), env);
  assert.equal(r.status, 429);
  r = await h.fetch(req("/ask", { body: { qid: "q-100098", messages: question() }, ip: "5.6.7.8" }), env);
  assert.equal(r.status, 200);
  const keys = JSON.stringify(db.raw.prepare("SELECT * FROM rate").all());
  assert.ok(!keys.includes("1.2.3.4") && !keys.includes("5.6.7.8"));
});

test("refusals: wrong origin, long question, forged history, bad roles, missing key", async () => {
  _resetConfigCache();
  const db = d1(), env = envWith(db), h = makeHandler(mockFetch([]), () => NOW);
  let r = await h.fetch(req("/ask", { body: { qid: "q-200001", messages: question() }, origin: "https://evil.example" }), env);
  assert.equal(r.status, 403);
  r = await h.fetch(req("/ask", { body: { qid: "q-200002", messages: question("x".repeat(1001)) } }), env);
  assert.equal((await r.json()).code, "too_long");
  const blocky = [{ role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "" }] },
                  { role: "assistant", content: "hi" }, ...question()];
  r = await h.fetch(req("/ask", { body: { qid: "q-200003", messages: blocky } }), env);
  assert.equal(r.status, 400);
  r = await h.fetch(req("/ask", { body: { qid: "q-200004", messages: [{ role: "system", content: "x" }] } }), env);
  assert.equal(r.status, 400);
  r = await h.fetch(req("/ask", { body: { qid: "q-200005", messages: question() } }), { ...env, ANTHROPIC_API_KEY: "" });
  assert.equal((await r.json()).code, "unavailable");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM questions").get().n, 0);
});

test("an unpriced model in the config is refused", async () => {
  _resetConfigCache();
  const db = d1(), env = envWith(db);
  const f = async (url) => new Response(JSON.stringify({ ...CONFIG, model: "claude-unpriced" }));
  const h = makeHandler(f, () => NOW);
  const r = await h.fetch(req("/ask", { body: { qid: "q-300001", messages: question() } }), env);
  assert.equal((await r.json()).code, "unavailable");
});

test("API overload maps to unavailable; API rate limit to rate_limited", async () => {
  _resetConfigCache();
  const db = d1(), env = envWith(db);
  const h = makeHandler(mockFetch([{ status: 529, body: { error: { type: "overloaded_error" } } },
                                   { status: 429, body: { error: { type: "rate_limit_error" } } }]), () => NOW);
  let r = await h.fetch(req("/ask", { body: { qid: "q-400001", messages: question() } }), env);
  assert.equal((await r.json()).code, "unavailable");
  r = await h.fetch(req("/ask", { body: { qid: "q-400002", messages: question() } }), env);
  assert.equal((await r.json()).code, "rate_limited");
});

test("retention deletes questions older than a year and rate rows older than two days", async () => {
  const db = d1(), env = envWith(db);
  db.raw.prepare("INSERT INTO questions (qid, ts, question) VALUES ('old', '2025-10-01T00:00Z', 'q'), ('new', '2026-10-01T00:00Z', 'q')").run();
  db.raw.prepare("INSERT INTO rate VALUES ('a', '2026-10-01', '2026-10-01T00', 1, 1), ('b', '2026-10-15', '2026-10-15T11', 1, 1)").run();
  await retention(env, NOW);
  assert.deepEqual(db.raw.prepare("SELECT qid FROM questions").all().map(r => r.qid), ["new"]);
  assert.deepEqual(db.raw.prepare("SELECT key FROM rate").all().map(r => r.key), ["b"]);
});

test("language detection", () => {
  assert.equal(detectLanguage("Beth yw'r prif ffactorau sy'n rheoli lefel y dŵr daear?"), "cy");
  assert.equal(detectLanguage("Jakie czynniki wpływają na poziom wód gruntowych?"), "pl");
  assert.equal(detectLanguage("What drives the water table?"), "en");
});

test("analyse collects every id the searches returned", () => {
  const msgs = [...question(),
    { role: "assistant", content: [{ type: "tool_use", id: "t", name: "cluster_summary", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: JSON.stringify([{ id: "r3" }]) }] }];
  const a = analyse(msgs, CONFIG);
  assert.deepEqual([...a.retrieved].sort(), ["d12", "f:outputs/02_cluster_stats.csv", "n5", "r3"]);
  assert.equal(a.rounds, 1);
  assert.equal(a.isNewQuestion, false);
});
