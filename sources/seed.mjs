// The owner's own statements: seed/*.json → devintel.statement.v1 records.
//   node sources/seed.mjs --dir seed --publisher <0x…> --output-dir .ship/stage/<ns>
//        [--publish --namespace <ns> --fangorn-bin <cli>]
// A seed file is one statement or an array of them:
//   { kind, statement, question?, argument, claims?: [{text, cites:[i]}], evidence: [{type, ref, excerpt?, sha256?, retrieved_at?}],
//     subject?, project?, tags, created_at, valid_for?, model?, cost_tokens?, cost_seconds?, origin?, supports?, refutes?, supersedes? }
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";

export const TYPE = "devintel.statement.v1";
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values: a } = parseArgs({ options: {
    dir: { type: "string" }, publisher: { type: "string" }, "output-dir": { type: "string" },
    publish: { type: "boolean" }, namespace: { type: "string" }, "fangorn-bin": { type: "string", default: "fangorn" },
    "repo-dir": { type: "string", default: ".ship/repo" }, volume: { type: "string", default: "1" } } });
  for (const k of ["dir", "publisher", "output-dir"]) if (!a[k]) throw new Error(`--${k} is required`);

  const records = readdirSync(a.dir).filter((f) => f.endsWith(".json")).sort()
    .flatMap((f) => [JSON.parse(readFileSync(join(a.dir, f), "utf8"))].flat().map((d) => record(d, a.publisher)));
  const ids = new Set();
  for (const r of records) { if (ids.has(r.id)) throw new Error(`duplicate id ${r.id}`); ids.add(r.id); }

  const out = resolve(a["output-dir"]);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `volume_${a.volume}_statements.json`), JSON.stringify(records.map((r) => ({ name: r.id, fields: r.payload })), null, 1));
  console.error(`[seed] ${records.length} statements → ${out}`);

  if (a.publish) {
    if (!a.namespace) throw new Error("--publish needs --namespace");
    // The app's own repo holds @card too, so this commits into the directory that already tracks it
    // and never passes --replace (which would drop @card): a commit upserts by id.
    const cwd = resolve(a["repo-dir"]);
    mkdirSync(cwd, { recursive: true });
    const [bin, ...pre] = a["fangorn-bin"].split(/\s+/);
    const cli = (...args) => execFileSync(bin, [...pre, ...args], { cwd, stdio: ["ignore", "inherit", "inherit"] });
    if (!existsSync(join(cwd, ".fangorn/repo.json"))) cli("repo", "init", a.namespace);
    const file = join(cwd, "records.json");
    writeFileSync(file, JSON.stringify({ records: records.map((r) => ({ id: r.id, type: TYPE, payload: r.payload })) }));
    cli("commit", file);
    cli("push");
  }
}
