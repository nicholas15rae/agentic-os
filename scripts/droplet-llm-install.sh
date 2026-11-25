#!/usr/bin/env bash
# RETIRED (2026-11-24). Do not use.
#
# This script installed Qwen3-0.6B on the droplet with no disk or memory pre-flight checks and
# left old model files on disk. Together with other leftovers it filled the 10 GB disk and
# exhausted RAM + swap; the droplet stopped answering SSH and the web console and was destroyed.
#
# Use scripts/droplet-bootstrap.sh instead: pinned versions, sha256-verified downloads, one model
# on disk, hard disk/RAM guardrails, capped logs, guarded swap, OOM shielding for SSH and the
# DigitalOcean agent. See AGENTS.md "Hardware Constraints".
echo "droplet-llm-install.sh is retired. Use scripts/droplet-bootstrap.sh (see AGENTS.md)." >&2
exit 1
