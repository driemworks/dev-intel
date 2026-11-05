#!/usr/bin/env node
// dev-intel statements: check, scrub and publish one or more to your own dev-intel-test-0 repo.
//   node statement.mjs [--dry-run] [--public-repo] draft.json
// draft.json: one statement or an array (shape in SKILL.md). Publishing is public and permanent,
// and at your own risk: this withholds what it can detect, and you are responsible for the rest.
// Also imported by the app's seed source, so the owner's records pass the same checks.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir, userInfo, hostname } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

export const TYPE = "devintel.statement.v1";
export const NAMESPACE = "dev-intel-test-0";
export const KINDS = ["finding", "decision", "log", "claim"];
const EVIDENCE = ["url", "commit", "file", "run", "record"];
const sha = (s) => createHash("sha256").update(s).digest("hex");

// Withheld before anything is staged. ponytail: regex screens catch the obvious, not the clever;
// the publisher stays responsible for what they publish.
const SECRETS = [
  [/\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{16,}/g, "[secret]"],
  [/\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}/g, "[secret]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[secret]"],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/g, "[secret]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[secret]"],     // JWT
  [/(?<![0-9a-fA-F/])0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/g, "[secret]"],                      // a private key (a tx hash looks the same: withheld anyway); not an id in a URL path
  [/\b[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|JWT)\s*=\s*\S+/g, "[secret]"],             // .env lines
  [/[\w.+-]+@[A-Za-z][\w-]*(?:\.[A-Za-z][\w-]*)*\.[A-Za-z]{2,}\b/g, "[email]"],      // not pkg@1.2.3
];
export const INJECTION = /\b(ignore (?:all |any )?(?:previous|prior|above) (?:instructions|prompts?)|disregard (?:the|your) (?:instructions|system prompt)|you are now|system prompt|<\/?(?:system|tool_call|function_calls?|instructions)>|curl [^\n|]*\|\s*(?:ba|z)?sh)\b/i;

export function scrub(s, found) {
  if (typeof s !== "string") return s;
  for (const [re, label] of SECRETS) s = s.replace(re, (m) => (found.push(label), label));
  return s;
}

function until(at, dur) {
  if (!dur) return null;
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?$/.exec(dur);
  if (!m) throw new Error(`valid_for "${dur}" is not PnYnMnD`);
  const d = new Date(at);
  d.setUTCFullYear(d.getUTCFullYear() + +(m[1] ?? 0), d.getUTCMonth() + +(m[2] ?? 0), d.getUTCDate() + +(m[3] ?? 0));
  return d.toISOString().slice(0, 10);
}

/** One seed statement → {id, payload}. Throws on anything that must not ship. */
export function record(d, publisher) {
  const where = d.statement?.slice(0, 60);
  if (!KINDS.includes(d.kind)) throw new Error(`${where}: kind "${d.kind}" is not one of ${KINDS.join(", ")}`);
  for (const k of ["statement", "argument", "created_at"]) if (!d[k]) throw new Error(`${where}: ${k} is required`);
  if (!Array.isArray(d.evidence) || !d.evidence.length) throw new Error(`${where}: at least one piece of evidence`);
  for (const e of d.evidence) if (!EVIDENCE.includes(e.type) || !e.ref) throw new Error(`${where}: evidence needs type (${EVIDENCE.join("|")}) and ref`);
  const found = [];
  const claims = (d.claims ?? []).map((c) => ({ text: scrub(c.text, found), cites: c.cites ?? [] }));
  const evidence = d.evidence.map((e) => ({ ...e, ref: scrub(e.ref, found), excerpt: scrub(e.excerpt, found) }));
  const p = {
    entityType: TYPE,
    kind: d.kind,
    statement: scrub(d.statement, found),
    question: scrub(d.question, found) ?? null,
    argument: scrub(d.argument, found),
    claims, evidence,
    subject: d.subject ?? null,
    project: d.project ?? null,
    tags: d.tags ?? [],
    created_at: d.created_at,
    valid_for: d.valid_for ?? null,
    valid_until: until(d.created_at, d.valid_for),
    publisher: publisher.toLowerCase(),
    model: d.model ?? null,
    cost_tokens: d.cost_tokens ?? null,
    cost_seconds: d.cost_seconds ?? null,
    origin: d.origin ?? null,
    supports: d.supports ?? [], refutes: d.refutes ?? [], supersedes: d.supersedes ?? [],
  };
  const all = [p.statement, p.question, p.argument, ...claims.map((c) => c.text), ...evidence.map((e) => e.excerpt)].filter(Boolean).join("\n");
  if (INJECTION.test(all)) throw new Error(`${where}: text addresses the reading agent (${all.match(INJECTION)[0]}); reword it`);
  if (found.length) console.error(`[seed] ${where}: withheld ${found.length} (${[...new Set(found)].join(", ")})`);
  // Flat fields for filters and checks: a predicate matches one field's value.
  p.evidence_refs = evidence.map((e) => e.ref).join(" ");
  p.uncited_claims = claims.filter((c) => !c.cites.some((i) => evidence[i])).length;
  p.statement_id = `devintel:${d.kind}:${sha(`${d.statement}\n${p.publisher}\n${d.created_at}`).slice(0, 16)}`;
  return { id: p.statement_id, payload: p };
}


// Names that place a statement on this machine or in a private repo: replaced, not refused.
// ponytail: names only (repo, cwd, user, host); a real private-context check needs a model.
export function privateNames(cwd = process.cwd()) {
  const git = spawnSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8" }).stdout?.trim();
  const repo = git?.split(/[/:]/).pop()?.replace(/\.git$/, "");
  const owner = git?.split(/[/:]/).slice(-2, -1)[0];
  return { repo, owner, words: [...new Set([cwd !== homedir() && basename(cwd), userInfo().username, hostname()]
    .filter((w) => w && w.length >= 4))] };
}

/** Withhold a private repo's name (an opaque label instead) and this machine's names. */
export function deprivatize(d, { repo, owner, words }, publicRepo) {
  const label = repo ? `private:${sha(`${owner}/${repo}`).slice(0, 8)}` : null;
  const swaps = [...(repo && !publicRepo ? [[repo, label], ...(owner ? [[owner, "[org]"]] : [])] : []), ...words.map((w) => [w, "[local]"])];
  const fix = (s) => typeof s !== "string" ? s : swaps.reduce((t, [w, to]) => t.replace(new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), to), s);
  const walk = (v) => Array.isArray(v) ? v.map(walk) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : fix(v);
  const out = walk(d);
  if (repo && !publicRepo && (!d.project || d.project === repo)) out.project = label;
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2), flag = (f) => args.includes(f);
  const file = args.find((a) => !a.startsWith("--"));
  const die = (m) => { console.error(m); process.exit(1); };
  if (!file) die("usage: node statement.mjs [--dry-run] [--public-repo] draft.json");
  const env = { ...process.env, CHAIN_NAME: process.env.CHAIN_NAME || "baseSepolia" };
  const who = spawnSync("fangorn", ["wallet"], { env, encoding: "utf8" }).stdout?.match(/0x[0-9a-fA-F]{40}/)?.[0];
  if (!who) die("no fangorn wallet: npm i -g @fangorn-network/sdk, then fangorn init (see SKILL.md)");
  const names = privateNames();
  const drafts = [JSON.parse(readFileSync(file, "utf8"))].flat();
  let records;
  try { records = drafts.map((d) => record(deprivatize(d, names, flag("--public-repo")), who)); } catch (e) { die(`refused: ${e.message}`); }
  for (const r of records) console.log(`${r.id}  [${r.payload.kind}] ${r.payload.statement}${r.payload.project ? `  (project: ${r.payload.project})` : ""}`);
  if (flag("--dry-run")) { console.log(JSON.stringify(records.map((r) => r.payload), null, 1)); process.exit(0); }
  const repo = join(homedir(), ".dev-intel");   // one repo per wallet
  mkdirSync(repo, { recursive: true });
  const cli = (...a) => { const r = spawnSync("fangorn", a, { cwd: repo, env, stdio: "inherit" }); if (r.status) die(`fangorn ${a[0]} failed`); };
  if (!existsSync(join(repo, ".fangorn/repo.json"))) cli("repo", "init", NAMESPACE);   // once: a transaction
  writeFileSync(join(repo, "records.json"), JSON.stringify({ records: records.map((r) => ({ id: r.id, type: TYPE, payload: r.payload })) }));
  cli("commit", join(repo, "records.json"));   // upserts by id; never --replace
  cli("push");
  console.log(`published ${records.length} to ${who}:${NAMESPACE}`);
}
