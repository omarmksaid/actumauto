#!/usr/bin/env bash
# Point the local dashboard at either backend.
#
#   ./scripts/use-backend.sh deployed   # Railway — no local API needed
#   ./scripts/use-backend.sh local      # localhost:3000
#
# NEXT_PUBLIC_* are compiled into the bundle, so the dev server must be restarted after this.
set -euo pipefail
cd "$(dirname "$0")/.."

DEPLOYED="https://actumauto-backend-production.up.railway.app"
case "${1:-}" in
  deployed) URL="$DEPLOYED" ;;
  local)    URL="http://localhost:3000" ;;
  *) echo "usage: $0 [deployed|local]"; exit 1 ;;
esac

sed -i '' "s|^NEXT_PUBLIC_API_URL=.*|NEXT_PUBLIC_API_URL=$URL|" web/.env.local
echo "  dashboard -> $URL"
echo "  restart the dev server for this to take effect (NEXT_PUBLIC_* are build-time)."
