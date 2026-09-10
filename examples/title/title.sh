#!/bin/bash
set -euo pipefail

# Provider CLI reference only. This is not antigyc runtime UI; see ../README.md.

# Read JSON payload from stdin
DATA=$(cat)

# Extract fields as data, never as shell source.
STATE=$(printf '%s' "$DATA" | jq -r '.agent_state // "idle"' 2>/dev/null || printf '%s\n' 'idle')
CWD=$(printf '%s' "$DATA" | jq -r '.workspace.current_dir // ""' 2>/dev/null || printf '%s\n' '')

# Try to extract CitC workspace name from CWD
if [ -n "$CWD" ]; then
  if [[ "$CWD" =~ /google/src/cloud/[^/]+/([^/]+) ]]; then
    WORKSPACE="${BASH_REMATCH[1]}"
  else
    WORKSPACE=$(basename "$CWD")
  fi
else
  WORKSPACE="unknown"
fi

# Map state to emoji
case "$STATE" in
  initializing) EMOJI="🚀" ;;
  idle)         EMOJI="😴" ;;
  thinking)     EMOJI="🤔" ;;
  working)      EMOJI="🏃" ;;
  tool_use)     EMOJI="🛠️" ;;
  *)            EMOJI="🤖" ;;
esac

TITLE="$EMOJI $STATE | $WORKSPACE"

echo "$TITLE"
