#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# License headers and the open core boundary (orkstage-dev docs/open-source-launch.md, L8):
# - every source file starts with an SPDX identifier: AGPL-3.0-only, or LicenseRef-OrkStage-Enterprise
#   inside an ee/ directory;
# - code outside ee/ never imports from ee/, except the composition root that registers it.
# `bash scripts/spdx.sh --fix` adds missing headers (after a shebang line when there is one).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# Files allowed to import from ee/ (space separated).
EE_IMPORTERS="apps/api/src/app.module.ts"

fix=false
[ "${1:-}" = "--fix" ] && fix=true
status=0

while IFS= read -r f; do
  case "/$f" in
    */ee/*) id='LicenseRef-OrkStage-Enterprise' ;;
    *) id='AGPL-3.0-only' ;;
  esac
  head -n 3 "$f" | grep -q "SPDX-License-Identifier: $id" && continue
  if head -n 3 "$f" | grep -q 'SPDX-License-Identifier:'; then
    echo "wrong SPDX identifier (expected $id): $f"
    status=1
  elif $fix; then
    if head -n 1 "$f" | grep -q '^#!'; then
      sed -i "1a // SPDX-License-Identifier: $id" "$f"
    else
      sed -i "1i // SPDX-License-Identifier: $id" "$f"
    fi
  else
    echo "missing SPDX header ($id): $f"
    status=1
  fi
done < <(git ls-files '*.ts' '*.tsx' '*.mts' '*.mjs' '*.cjs' '*.js' '*.rs' |
  grep -v -E '(^|/)(generated|dist|node_modules)/|\.d\.ts$|tests/fixtures/' || true)

while IFS= read -r hit; do
  file=${hit%%:*}
  case " $EE_IMPORTERS " in *" $file "*) continue ;; esac
  echo "imports from ee/ outside ee/: $hit"
  status=1
done < <(git grep -n -E "(from|import\\() *['\"][^'\"]*/ee/" -- '*.ts' '*.tsx' '*.mts' '*.mjs' ':!*/ee/*' ':!ee/*' || true)

if [ "$status" -eq 0 ]; then echo "SPDX headers and the ee/ boundary are in order."; fi
exit "$status"
