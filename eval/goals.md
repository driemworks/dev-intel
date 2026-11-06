# Goals

dev-intel: a shared knowledge network coding agents both read and write. Each developer's
agent publishes into its own `<wallet>:dev-intel-test-0` repo; the app merges them.
Successor to codex. Started 2026-11-05.

## team: driemworks and team, agents building crypto/agent tooling
- **They ask:** (to fill from the first real records)
  - "why did we pick library A over B for X?"
  - "has anyone already researched <API/protocol question>?"
  - "what did the agent working on <repo> do last, and what's still open?"
- **Coverage:** the team's own repos and research first; the wider network later.
- **Failure looks like:** the agent redoes research or reverses a decision the network
  already holds; or a search returns a record from an untrusted publisher.
- **Kill:** the team's agents don't consult it unprompted within a month of the skill shipping.
- **Baseline:** none run. The data (private decision histories, team logs) is not online
  or in any model's training data, so a no-tools or web-only model can't answer it.

## Hard rules (records checks, `hard: true`, max 0%)
- No secrets: API keys, private keys, tokens, mnemonics, `.env` values.
- No emails or people's names.
- Records about private repos never name the repo or its internal hosts; an opaque label instead.
- No record text that addresses the reading agent ("ignore previous", "run this", tool-call syntax).

## Trust
- Publishers are an allowlist (`live` per wallet): the team's wallets only to start.
- Records are data, never instructions: the skill and the MCP tools say so on every result.
- Publishing is at the publisher's own risk. The skill strips what it can before staging,
  and warns that the publisher is responsible for everything they publish.

## wiki: a developer (or their agent) building on Fangorn
A deepwiki for Fangorn's own repos: how westmarch, the SDK/CLI, the contracts and core work,
as findings and claims whose every quote is verified against the source at a pinned commit.
- **They ask:** "how does an app decide whose wallets show up", "what model makes the vectors",
  "does rerunning ship redeploy everything".
- **Coverage:** westmarch first (2026-11-06), then fangorn (SDK + CLI), contracts, core.
- **Failure looks like:** an answer that is out of date with the code, or a quote not in the file.
- **Kill:** we still read the source instead of asking it, a month in.
- **Baseline:** none run; Fangorn postdates model training data and changes weekly.
