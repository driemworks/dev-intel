// The owner's own statements: seed/*.json → devintel.statement.v1 records.
//   node sources/seed.mjs --dir seed --publisher <0x…> --output-dir .ship/stage/<ns>
//        [--publish --namespace <ns> --fangorn-bin <cli>]
// A seed file is one statement or an array of them:
//   { kind, statement, question?, argument, claims?: [{text, cites:[i]}], evidence: [{type, ref, excerpt?, sha256?, retrieved_at?}],
//     subject?, project?, tags, created_at, valid_for?, model?, cost_tokens?, cost_seconds?, origin?, supports?, refutes?, supersedes? }
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

import { TYPE, record } from "../plugin/skills/dev-intel/statement.mjs";   // one scrubber and id scheme for owner and publishers

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
