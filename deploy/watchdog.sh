#!/usr/bin/env bash
# Every minute (sattleme-mcp-watchdog.timer): restarts the assistant when Docker reports its health
# check failing. Docker restarts a container that exits, not one that is still running but stuck.
# An assistant stopped on purpose (sudo sattleme-mcp stop mcp) is left alone.
set -euo pipefail

id=$(/usr/local/sbin/sattleme-mcp ps -q mcp 2>/dev/null || true)
[[ -n $id ]] || exit 0
health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id" 2>/dev/null || true)
[[ $health == unhealthy ]] || exit 0
echo "assistant unhealthy: restarting it"
/usr/local/sbin/sattleme-mcp restart mcp
