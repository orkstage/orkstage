#!/usr/bin/env bash
# Splits this monorepo into the polyrepo layout described in docs/POLYREPO.md.
# Local only: creates repositories under OUT_DIR with history; never creates remotes or pushes.
#
#   scripts/polyrepo/split.sh ../orkstage-split
set -euo pipefail

OUT_DIR=${1:?usage: split.sh <out-dir>}
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
[ -z "$(git status --porcelain)" ] || { echo "Working tree is not clean; commit or stash first." >&2; exit 1; }
mkdir -p "$OUT_DIR"
OUT_DIR=$(cd "$OUT_DIR" && pwd)
HEAD_SHA=$(git rev-parse --short HEAD)
export GIT_AUTHOR_NAME=${GIT_AUTHOR_NAME:-$(git config user.name)} GIT_AUTHOR_EMAIL=${GIT_AUTHOR_EMAIL:-$(git config user.email)}

log() { printf '\n==> %s\n' "$*"; }

# Rename the internal @co/* scope to the published @orkstage/* scope inside one repository.
rename_scope() {
  local dir=$1
  (cd "$dir"
    git ls-files -z -- '*.ts' '*.tsx' '*.mjs' '*.json' '*.md' '*.yaml' '*.yml' '*.prisma' 'Dockerfile' '*.Dockerfile' ':!scripts/polyrepo' \
      | xargs -0 -r grep -lZ '@co/' 2>/dev/null \
      | xargs -0 -r sed -i 's#@co/#@orkstage/#g'
    if ! git diff --quiet; then
      git add -A && git commit -q -m "chore: publish packages under the @orkstage scope"
    fi)
}

# One folder → one repository, history preserved.
split_folder() {
  local prefix=$1 name=$2
  if [ ! -d "$prefix" ]; then echo "skip $name: $prefix not in this commit"; return; fi
  log "$name  ←  $prefix"
  git branch -D "split/$name" >/dev/null 2>&1 || true
  git subtree split -q --prefix="$prefix" -b "split/$name"
  rm -rf "${OUT_DIR:?}/$name"
  git clone -q --branch "split/$name" --single-branch "$ROOT" "$OUT_DIR/$name"
  (cd "$OUT_DIR/$name" && git branch -m main && git remote remove origin)
  git branch -D "split/$name" >/dev/null
}

# ── orkstage (core): everything except what moves to its own repo ──
log "orkstage (core)"
rm -rf "${OUT_DIR:?}/orkstage"
git clone -q "$ROOT" "$OUT_DIR/orkstage"
(cd "$OUT_DIR/orkstage"
  git remote remove origin
  git rm -r -q --ignore-unmatch apps/web cli site infra/tofu infra/docker/tofu-runner.Dockerfile
  git commit -q -m "chore: split console, cli, site and modules into their own repositories (from $HEAD_SHA)")
rename_scope "$OUT_DIR/orkstage"

# ── single-folder repositories ──
split_folder apps/web orkstage-console
split_folder cli orkstage-cli
split_folder site orkstage-site
split_folder infra/tofu orkstage-modules

if [ -d "$OUT_DIR/orkstage-console" ]; then
  (cd "$OUT_DIR/orkstage-console"
    cp "$ROOT/tsconfig.base.json" ./tsconfig.base.json
    sed -i 's#"\.\./\.\./tsconfig\.base\.json"#"./tsconfig.base.json"#' tsconfig.json 2>/dev/null || true
    # Workspace links become published versions.
    node -e "const f='package.json',j=require('./'+f);for(const k of ['dependencies','devDependencies'])for(const d in j[k]??{})if(j[k][d]==='workspace:*')j[k][d]='^0.1.0';require('fs').writeFileSync(f,JSON.stringify(j,null,2)+'\n')"
    cp "$ROOT/LICENSE" ./LICENSE
    git add -A && git commit -q -m "chore: standalone console (published @orkstage packages, own tsconfig base)")
  rename_scope "$OUT_DIR/orkstage-console"
fi

if [ -d "$OUT_DIR/orkstage-modules" ]; then
  (cd "$OUT_DIR/orkstage-modules"
    mkdir -p docker
    sed 's#COPY infra/tofu/modules /modules#COPY modules /modules#' "$ROOT/infra/docker/tofu-runner.Dockerfile" > docker/tofu-runner.Dockerfile
    curl -sSfL https://www.apache.org/licenses/LICENSE-2.0.txt -o LICENSE || echo "Fetch the Apache-2.0 text into LICENSE" > LICENSE
    git add -A && git commit -q -m "chore: runner image and Apache-2.0 license for the module library")
fi

# ── orkstage-dev (meta): compose + submodules pinned to the split repos ──
log "orkstage-dev (meta)"
rm -rf "${OUT_DIR:?}/orkstage-dev"
mkdir -p "$OUT_DIR/orkstage-dev"
cp -r "$ROOT/infra/local/." "$OUT_DIR/orkstage-dev/"
(cd "$OUT_DIR/orkstage-dev"
  git init -q -b main
  for repo in orkstage orkstage-console orkstage-cli orkstage-modules orkstage-site; do
    [ -d "$OUT_DIR/$repo/.git" ] || continue
    git -c protocol.file.allow=always submodule add -q "$OUT_DIR/$repo" "$repo"
    git config -f .gitmodules "submodule.$repo.url" "https://github.com/orkstage/$repo.git"
  done
  cat > README.md <<'EOF'
# orkstage-dev

Runs the whole OrkStage platform locally from pinned versions of every repository.

```bash
git clone --recurse-submodules https://github.com/orkstage/orkstage-dev.git
cd orkstage-dev
docker compose -f docker-compose.yml --profile platform --profile aws-emulator up -d --build --wait
```

Move a component to its latest main: `git submodule update --remote <repo>` and commit the new pin.
EOF
  git add -A && git commit -q -m "chore: meta repository with pinned submodules")

log "Done. Repositories in $OUT_DIR:"
ls -1 "$OUT_DIR"
echo
echo "Nothing was pushed. Review each repository, then create remotes explicitly, e.g.:"
echo "  gh repo create orkstage/orkstage --public --source $OUT_DIR/orkstage --push"
