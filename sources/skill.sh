#!/bin/sh
# Serve the skill's script beside SKILL.md and pin its hash in SKILL.md (which the card hashes on chain).
set -e
S=plugin/skills/dev-intel
mkdir -p pages/skill/dev-intel-test-0 && cp $S/statement.mjs pages/skill/dev-intel-test-0/
H=$(sha256sum $S/statement.mjs | cut -d' ' -f1)
sed -i "s/^STATEMENT_SHA256: .*/STATEMENT_SHA256: $H/" $S/SKILL.md
echo "statement.mjs $H"
# The workflow developers copy, with both hashes pinned.
K=$(sha256sum $S/SKILL.md | cut -d' ' -f1)
sed -e "s/__SKILL_SHA256__/$K/" -e "s/__STATEMENT_SHA256__/$H/" plugin/workflow/dev-intel.yml > pages/skill/dev-intel-test-0/dev-intel.yml
echo "SKILL.md $K → pages/skill/dev-intel-test-0/dev-intel.yml"
