#!/usr/bin/env bash
# Splits this monorepo into the polyrepo layout described in docs/POLYREPO.md.
# Local only: creates repositories under OUT_DIR with history; never creates remotes or pushes.
# Publishing is a separate step: `scripts/polyrepo/publish.sh` (see its `--dry-run` option).
#
#   `scripts/polyrepo/split.sh ../orkstage-split`
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

# Never published: raw brand kit sources and the original specification (see .gitignore).
# .claude holds local Claude Code permissions for this machine, not project content.
PRIVATE_PATHS="assets-files cloud_instance_management_platform_superprompt_v2_multicloud.md .claude"

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

# MIT license text for the repositories that use it (docs/OPEN_CORE.md, docs/POLYREPO.md).
mit_license() {
  cat <<'EOF'
MIT License

Copyright (c) 2026 OrkStage

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
EOF
}

# One folder becomes one repository, history preserved.
split_folder() {
  local prefix=$1 name=$2
  if [ ! -d "$prefix" ]; then echo "skip $name: $prefix not in this commit"; return; fi
  log "$name  (from $prefix)"
  git branch -D "split/$name" >/dev/null 2>&1 || true
  git subtree split -q --prefix="$prefix" -b "split/$name"
  rm -rf "${OUT_DIR:?}/$name"
  git clone -q --branch "split/$name" --single-branch "$ROOT" "$OUT_DIR/$name"
  (cd "$OUT_DIR/$name" && git branch -m main && git remote remove origin)
  git branch -D "split/$name" >/dev/null
}

# ── orkstage (core): everything except what moves to its own repository ──
log "orkstage (core)"
rm -rf "${OUT_DIR:?}/orkstage"
git clone -q "$ROOT" "$OUT_DIR/orkstage"
(cd "$OUT_DIR/orkstage"
  git remote remove origin
  # The clone is on whatever branch the monorepo had checked out; published repositories use main.
  git branch -M main
  # Private material must not exist anywhere in the published history, not just at HEAD.
  FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --prune-empty --index-filter \
    "git rm -r -q --cached --ignore-unmatch $PRIVATE_PATHS" -- --all >/dev/null
  git for-each-ref --format='%(refname)' refs/original/ | xargs -r -n1 git update-ref -d
  git reflog expire --expire=now --all && git gc -q --prune=now
  # `infra/local/README.md` and `infra/local/.github` belong to the `orkstage-dev` meta repository.
  git rm -r -q --ignore-unmatch apps/web cli site infra/tofu infra/docker/tofu-runner.Dockerfile \
    infra/local/README.md infra/local/.github
  git commit -q -m "chore: split console, cli, site and modules into their own repositories (from $HEAD_SHA)")
rename_scope "$OUT_DIR/orkstage"
# Shared packages consumed by other repositories are published to GitHub Packages.
(cd "$OUT_DIR/orkstage"
  for p in domain contracts authorization templates; do
    node -e "const f='packages/$p/package.json',j=require('./'+f);delete j.private;j.publishConfig={registry:'https://npm.pkg.github.com',access:'public'};j.repository={type:'git',url:'https://github.com/orkstage/orkstage.git',directory:'packages/$p'};j.license='AGPL-3.0-only';require('fs').writeFileSync(f,JSON.stringify(j,null,2)+'\n')"
  done
  printf '@orkstage:registry=https://npm.pkg.github.com\n' > .npmrc
  # The scan engine (@orkstage/scan) is published by `orkstage-cli`. Until that package exists
  # the core repo does not declare it, so its lockfile stays installable with --frozen-lockfile;
  # the API loads it dynamically and answers 501 SCANNER_UNAVAILABLE without it. Once it is
  # published, add it back: `pnpm --filter @orkstage/api add @orkstage/scan`.
  node -e "const f='apps/api/package.json',j=require('./'+f);delete j.dependencies['@orkstage/scan'];require('fs').writeFileSync(f,JSON.stringify(j,null,2)+'\n')"
  sed -i '/scan-wasm/d;/@orkstage\/scan: the Rust scan engine/d' pnpm-workspace.yaml
  sed -i '/scan engine.s WebAssembly package/d;/^!cli\/dist\/scan-wasm$/d;/^cli\/target$/d;/^cli\/crates$/d;/^site$/d' .dockerignore
  # The monorepo lockfile still lists the removed workspaces; regenerate it so CI can install
  # with --frozen-lockfile. The optional scan engine may be unreachable here; pnpm skips it.
  pnpm install --lockfile-only --silent || echo "warning: could not refresh pnpm-lock.yaml; run pnpm install --lockfile-only in the core repo" >&2
  git add -A && git commit -q -m "chore: publish shared packages to GitHub Packages")

# ── single folder repositories ──
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
    printf '@orkstage:registry=https://npm.pkg.github.com\n' > .npmrc
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

if [ -d "$OUT_DIR/orkstage-site" ] && [ ! -f "$OUT_DIR/orkstage-site/LICENSE" ]; then
  (cd "$OUT_DIR/orkstage-site"
    mit_license > LICENSE
    git add LICENSE && git commit -q -m "chore: MIT license for the site code (content is CC BY 4.0)")
fi

# ── .github: organization profile and default community health files (no history needed) ──
log ".github (organization defaults)"
rm -rf "${OUT_DIR:?}/.github"
mkdir -p "$OUT_DIR/.github"
cp -r "$ROOT/scripts/polyrepo/org-dotgithub/." "$OUT_DIR/.github/"
(cd "$OUT_DIR/.github"
  git init -q -b main
  printf '* text=auto eol=lf\n*.png binary\n' > .gitattributes
  git add -A && git commit -q -m "chore: organization profile and community health files (from $HEAD_SHA)")

# ── `orkstage-dev` (meta): compose, README and submodules pinned to the split repositories ──
# The .github repository is not a submodule: it holds no code to run.
log "orkstage-dev (meta)"
rm -rf "${OUT_DIR:?}/orkstage-dev"
mkdir -p "$OUT_DIR/orkstage-dev"
cp -r "$ROOT/infra/local/." "$OUT_DIR/orkstage-dev/"
(cd "$OUT_DIR/orkstage-dev"
  git init -q -b main
  printf '* text=auto eol=lf\n*.png binary\n' > .gitattributes
  mit_license > LICENSE
  for repo in orkstage orkstage-console orkstage-cli orkstage-modules orkstage-site; do
    [ -d "$OUT_DIR/$repo/.git" ] || continue
    git -c protocol.file.allow=always submodule add -q "$OUT_DIR/$repo" "$repo"
    git config -f .gitmodules "submodule.$repo.url" "https://github.com/orkstage/$repo.git"
  done
  git add -A && git commit -q -m "chore: meta repository with pinned submodules")

log "Done. Repositories in $OUT_DIR:"
ls -1A "$OUT_DIR"
echo
echo "Nothing was pushed. Review each repository, then publish them as private repositories:"
echo "  scripts/polyrepo/publish.sh --dry-run $OUT_DIR"
echo "  scripts/polyrepo/publish.sh $OUT_DIR"
