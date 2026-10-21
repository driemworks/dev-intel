#!/usr/bin/env python3
"""Open roles from companies' public job boards (Ashby, Lever, Greenhouse), one record per posting.

  python3 sources/boards.py --output-dir .ship/stage/jobs [--boards sources/boards.json]

A snapshot: each run reads every board in boards.json as it is now and replaces the last, so a
closed posting disappears. Adding a company is adding a row {company, ats, slug, network}.
Stages {name, fields} rows as westmarch-ship reads them.
"""
import argparse, html, json, os, re, sys, urllib.request
from datetime import datetime, timezone
import concurrent.futures as cf

TAG = "fellowship.job.v1"
EMBED_CHARS = 980   # the encoder's window: what the role is, then what the job asks
UA = {"User-Agent": "fellowship/0.1 (+https://fellowship.quickbeam.workers.dev)"}


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return json.load(r)


def plain(h):
    """HTML to prose, one block per line."""
    h = re.sub(r"(?i)<br\s*/?>|</(p|li|h\d|div|ul|ol)>", "\n", html.unescape(h or ""))
    t = html.unescape(re.sub(r"<[^>]+>", " ", h))
    return "\n".join(l for l in (" ".join(x.split()) for x in t.split("\n")) if l)


def ashby(b):
    for j in get(f"https://api.ashbyhq.com/posting-api/job-board/{b['slug']}?includeCompensation=true")["jobs"]:
        if not j.get("isListed", True):
            continue
        yield {"id": j["id"], "title": j["title"], "url": j["jobUrl"], "location": j.get("location") or "",
               "workplace": (j.get("workplaceType") or ("Remote" if j.get("isRemote") else "")),
               "department": j.get("department") or j.get("team") or "", "employment": j.get("employmentType") or "",
               "salary": ((j.get("compensation") or {}).get("scrapeableCompensationSalarySummary") or ""),
               "posted": (j.get("publishedAt") or "")[:10], "body": j.get("descriptionPlain") or plain(j.get("descriptionHtml"))}


def lever(b):
    for j in get(f"https://api.lever.co/v0/postings/{b['slug']}?mode=json"):
        c = j.get("categories") or {}
        lists = "\n".join(f"{l['text']}\n{plain(l['content'])}" for l in j.get("lists") or [])
        sr = j.get("salaryRange") or {}
        yield {"id": j["id"], "title": j["text"], "url": j["hostedUrl"], "location": c.get("location") or "",
               "workplace": j.get("workplaceType") or "", "department": c.get("team") or c.get("department") or "",
               "employment": c.get("commitment") or "",
               "salary": f"{sr['currency']} {sr['min']:,}–{sr['max']:,}" if sr.get("min") else "",
               "posted": datetime.fromtimestamp(j["createdAt"] / 1000, timezone.utc).strftime("%Y-%m-%d") if j.get("createdAt") else "",
               "body": "\n".join(filter(None, [j.get("descriptionPlain"), lists, j.get("additionalPlain")]))}


def greenhouse(b):
    for j in get(f"https://boards-api.greenhouse.io/v1/boards/{b['slug']}/jobs?content=true")["jobs"]:
        yield {"id": str(j["id"]), "title": j["title"], "url": j["absolute_url"], "location": (j.get("location") or {}).get("name") or "",
               "workplace": "", "department": ", ".join(d["name"] for d in j.get("departments") or []), "employment": "",
               "salary": "", "posted": (j.get("first_published") or j.get("updated_at") or "")[:10], "body": plain(j.get("content"))}


READ = {"ashby": ashby, "lever": lever, "greenhouse": greenhouse}

# ponytail: keyword heuristics on title + department; swap for a classifier if facets prove noisy
FUNCTIONS = [  # first match wins, so the specific before the general
    ("Legal & Compliance", r"legal|counsel|compliance|regulat|aml|kyc|risk|privacy|policy"),
    ("Security", r"secur|appsec|auditor|threat|cryptograph"),
    ("Research", r"research|scientist|economist|cryptographer|phd|biolog|clinical"),
    ("Data", r"\bdata\b|analytic|analyst|machine learning|\bml\b|\bai\b|business intelligence"),
    ("Design", r"design|\bux\b|\bui\b|brand|creative"),
    ("Product", r"product manager|product lead|head of product|\bproduct\b(?!.*engineer)|\bpm\b|program manager"),
    ("Developer Relations", r"devrel|developer relations|developer advocate|ecosystem|community"),
    ("Engineering", r"engineer|developer|\bsre\b|devops|architect|protocol|infrastructure|software|technical lead|\bcto\b"),
    ("Marketing", r"marketing|growth|content|communications|\bpr\b|social media|events|crm|lifecycle|affiliate"),
    ("Strategy & Investment", r"corporate development|strategy|strategist|investment|founder|special projects"),
    ("Sales & BD", r"sales|account (executive|manager)|business development|\bbd\b|partnership|revenue|institutional|trader|trading|solutions consultant|commercial|enterprise|go-to-market|gtm"),
    ("Finance", r"financ|accounting|accountant|controller|tax|treasury|payroll|fp&a"),
    ("People", r"people|recruit|talent|\bhr\b|human resources|compensation|benefits"),
    ("Customer Support", r"support|customer success|customer experience|client (experience|services)|\bcx\b|professional services|managed services"),
    ("Operations", r"operations|\bops\b|chief of staff|office|executive assistant|project manager|investor relations"),
]
SENIORITY = [
    ("Executive", r"\b(chief|cto|ceo|cfo|coo|vp|vice president|svp|evp|head of|general manager)\b"),
    ("Director", r"\bdirector\b"),
    ("Principal / Staff", r"\b(principal|staff|distinguished|fellow)\b"),
    ("Lead / Manager", r"\b(lead|manager)\b"),
    ("Senior", r"\b(senior|sr\.?|iii|iv)\b"),
    ("Intern / Junior", r"\b(intern|internship|junior|jr\.?|graduate|new grad|entry|apprentice)\b"),
]
SKILLS = {  # canonical → pattern, searched in title + body
    "Rust": r"\brust\b", "Solidity": r"\bsolidity\b", "Go": r"\bgolang\b|\bgo\b(?= |,|/)(?=.*(developer|engineer|backend))",
    "TypeScript": r"\btypescript\b", "JavaScript": r"\bjavascript\b|\bnode\.?js\b", "Python": r"\bpython\b", "C++": r"c\+\+",
    "Java": r"\bjava\b", "Kotlin": r"\bkotlin\b", "Swift": r"\bswift\b", "React": r"\breact\b", "Move": r"\bmove (language|smart)",
    "Kubernetes": r"\bkubernetes\b|\bk8s\b", "AWS": r"\baws\b", "GCP": r"\bgcp\b|google cloud", "Terraform": r"\bterraform\b",
    "SQL": r"\bsql\b|postgres", "EVM": r"\bevm\b", "Solana": r"\bsolana\b", "Ethereum": r"\bethereum\b", "Bitcoin": r"\bbitcoin\b",
    "ZK": r"zero[- ]knowledge|\bzk", "MPC": r"\bmpc\b|multi-party computation", "LLMs": r"\bllms?\b|large language model",
    "PyTorch": r"\bpytorch\b", "DeFi": r"\bdefi\b", "Stablecoins": r"stablecoin", "IPFS": r"\bipfs\b|filecoin",
}
# Not postings: standing invitations to apply. They match every resume and fit none.
NOT_A_ROLE = re.compile(r"(?i)general application|open application|pitch us|don.t see|expression of interest|dream job|good fit for|talent (pool|network|community)|future opportunit")
ROLE_START = re.compile(r"(?im)^(about the (role|job|position|opportunity)|the role|role overview|the opportunity|what you('|’)ll do|what you will do|"
                        r"responsibilities|key responsibilities|your role|in this role|what you'll be doing|the job)\b")


def first(table, s):
    return next((name for name, pat in table if re.search(pat, s, re.I)), "")


def remote(j):
    s = f"{j['workplace']} {j['location']}".lower()
    return "remote" if "remote" in s else "hybrid" if "hybrid" in s else "onsite" if s.strip() else ""


def role_text(body):
    """The description from where it starts describing the role, skipping the company's About."""
    m = ROLE_START.search(body)
    return body[m.start():] if m and m.start() > 200 else body


def record(b, j):
    jid = f"fellowship:{b['ats']}:{b['slug']}:{j['id']}"
    func = first(FUNCTIONS, j["title"]) or first(FUNCTIONS, j["department"]) or "Other"
    level = first(SENIORITY, j["title"]) or "Mid"
    skills = sorted(k for k, p in SKILLS.items() if re.search(p, f"{j['title']}\n{j['body']}", re.I))
    where = remote(j)
    head = (f"{j['title']} at {b['company']}. {func}, {level}" + (f", {where}" if where else "")
            + (f", {j['location']}" if j["location"] else "") + "." + (f" Skills: {', '.join(skills)}." if skills else ""))
    return {"name": jid, "fields": {
        "entityType": TAG, "job_id": jid, "title": j["title"], "company": b["company"], "network": b.get("network") or "",
        "ats": b["ats"], "url": j["url"], "location": j["location"], "remote": where, "function": func, "seniority": level,
        "department": j["department"], "employment": j["employment"], "salary": j["salary"], "posted": j["posted"],
        "skills": skills, "body": j["body"],
        "text": f"{head}\n{re.sub(r'\n\s*\n', '\n', role_text(j['body']))}"[:EMBED_CHARS],
    }}


def board(b):
    try:
        return b, [record(b, j) for j in READ[b["ats"]](b) if not NOT_A_ROLE.search(j["title"])], None
    except Exception as e:
        return b, [], e


def main(argv):
    p = argparse.ArgumentParser()
    p.add_argument("--output-dir", required=True)
    p.add_argument("--boards", default=os.path.join(os.path.dirname(__file__), "boards.json"))
    p.add_argument("--publish", action="store_true", help="commit the staged roles into --namespace and push")
    p.add_argument("--namespace")
    p.add_argument("--fangorn-bin", default="fangorn")
    p.add_argument("--replace", action="store_true", help="ignored: a snapshot always replaces")
    a = p.parse_args(argv)
    rows, bad = {}, []
    with cf.ThreadPoolExecutor(8) as ex:
        for b, recs, err in ex.map(board, json.load(open(a.boards))):
            if err:
                bad.append(f"{b['company']}: {err}")
            for r in recs:
                rows[r["name"]] = r
    # A board that fails must not wipe its company's roles from a snapshot: stop instead.
    if bad:
        sys.exit("[boards] failed, nothing staged:\n  " + "\n  ".join(bad))
    os.makedirs(a.output_dir, exist_ok=True)
    with open(os.path.join(a.output_dir, "volume_1_jobs.json"), "w") as f:
        json.dump(list(rows.values()), f)
    print(f"[boards] staged {len(rows)} roles → {a.output_dir}", file=sys.stderr)
    if a.publish:
        publish(list(rows.values()), a)


def publish(rows, a):
    """repo init + commit --replace + push, from one directory per namespace (the CLI finds
    .fangorn/repo.json by searching upward). --replace: closed postings leave the app."""
    import shlex, subprocess
    if not a.namespace:
        sys.exit("[boards] --publish needs --namespace")
    cwd = os.path.join(a.output_dir, ".fangorn-repos", a.namespace)
    os.makedirs(cwd, exist_ok=True)
    batch = os.path.abspath(os.path.join(cwd, "batch.json"))
    with open(batch, "w") as f:
        json.dump({"records": [{"id": r["name"], "type": TAG, "payload": r["fields"]} for r in rows]}, f)
    for step in (["repo", "init", a.namespace], ["commit", batch, "-m", f"boards: {len(rows)} roles", "--replace"], ["push"]):
        subprocess.run([*shlex.split(a.fangorn_bin), *step], cwd=cwd, check=True)
    print(f"[boards] published {len(rows)} roles to {a.namespace}", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1:])
