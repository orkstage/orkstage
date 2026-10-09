#!/usr/bin/env bash
# Publishes the repositories produced by split.sh to the GitHub organization, using the GitHub CLI.
#
#   `scripts/polyrepo/publish.sh [--dry-run] [--only name[,name]] [--ssh] <split-dir>`
#
# For every repository in repos.json whose folder exists in the split directory:
#   1. creates it as PRIVATE when it does not exist (an existing repository keeps its visibility),
#   2. pushes main and the tags (never forced),
#   3. sets description, homepage, topics, issues, discussions and the default branch, and
#      disables the wiki,
# then prints the steps that cannot be scripted (social preview, branch protection on private
# repositories, visibility changes).
#
# Idempotent: running it again creates nothing new and pushes only new commits.
# Refuses to run when any repository in the split output has uncommitted or untracked changes.
# `--dry-run` prints every action and makes no network call (no gh, no git push).
# ORKSTAGE_ORG overrides the organization from repos.json (for a rehearsal on a test account).
set -euo pipefail
[ "${BASH_VERSINFO[0]}" -ge 4 ] || { echo "bash 4 or later is required (on macOS: brew install bash)" >&2; exit 1; }

usage() { echo "usage: publish.sh [--dry-run] [--only name[,name]] [--ssh] <split-dir>" >&2; exit 2; }

DRY_RUN=false
ONLY=""
PROTOCOL=https
SPLIT_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --only) shift; [ $# -gt 0 ] || usage; ONLY=$1 ;;
    --only=*) ONLY=${1#--only=} ;;
    --ssh) PROTOCOL=ssh ;;
    -h|--help) usage ;;
    -*) echo "unknown option: $1" >&2; usage ;;
    *) [ -z "$SPLIT_DIR" ] || usage; SPLIT_DIR=$1 ;;
  esac
  shift
done
[ -n "$SPLIT_DIR" ] || usage
[ -d "$SPLIT_DIR" ] || { echo "split directory not found: $SPLIT_DIR" >&2; exit 1; }
SPLIT_DIR=$(cd "$SPLIT_DIR" && pwd)

HERE=$(cd "$(dirname "$0")" && pwd)
REPOS_JSON="$HERE/repos.json"
command -v node >/dev/null || { echo "node is required to read repos.json" >&2; exit 1; }

# One line per repository: name, dir, visibility, hasIssues, hasDiscussions, openSource, socialPreview.
# Text fields (description, homepage, topics) are read separately so that tabs or quotes in them
# cannot break the parsing.
REPO_LINES=$(node -e '
  const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  for (const r of j.repos) console.log([r.name, r.dir ?? "-", r.visibility, r.hasIssues, r.hasDiscussions, r.openSource, r.socialPreview ?? "-"].join("\t"));
' "$REPOS_JSON")
ORG=${ORKSTAGE_ORG:-$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).org)' "$REPOS_JSON")}
field() { # field <repo name> <key>
  node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const r = j.repos.find((x) => x.name === process.argv[2]);
    const v = r[process.argv[3]];
    process.stdout.write(Array.isArray(v) ? v.join(",") : String(v ?? ""));
  ' "$REPOS_JSON" "$1" "$2"
}
topics_json() {
  node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(JSON.stringify({ names: j.repos.find((x) => x.name === process.argv[2]).topics }));
  ' "$REPOS_JSON" "$1"
}
selected() { [ -z "$ONLY" ] || [[ ",$ONLY," == *",$1,"* ]]; }

log() { printf '\n==> %s\n' "$*"; }
run() { # prints the command; executes it unless --dry-run
  printf '    $'; printf ' %q' "$@"; printf '\n'
  if [ "$DRY_RUN" = false ]; then "$@"; fi
}

# ── Preflight: every selected repository must be a clean git repository with a main branch ──
log "Preflight ($SPLIT_DIR, organization $ORG$([ "$DRY_RUN" = true ] && echo ', dry run'))"
TARGETS=()
problems=0
while IFS=$'\t' read -r name dir _; do
  selected "$name" || continue
  if [ "$dir" = "-" ]; then echo "    skip $name: not produced by split.sh (create it by hand when needed)"; continue; fi
  path="$SPLIT_DIR/$dir"
  if [ ! -d "$path" ]; then echo "    skip $name: $dir not found in the split output"; continue; fi
  if ! git -C "$path" rev-parse --git-dir >/dev/null 2>&1; then echo "    $name: not a git repository" >&2; problems=$((problems + 1)); continue; fi
  top=$(git -C "$path" rev-parse --show-toplevel)
  if [ "$(cd "$top" && pwd -P)" != "$(cd "$path" && pwd -P)" ]; then
    echo "    $name: $path is not the root of its own repository" >&2; problems=$((problems + 1)); continue
  fi
  if [ -n "$(git -C "$path" status --porcelain --ignore-submodules=none)" ]; then
    echo "    $name: uncommitted or untracked changes in $path" >&2; problems=$((problems + 1)); continue
  fi
  if ! git -C "$path" show-ref --verify --quiet refs/heads/main; then
    echo "    $name: no main branch" >&2; problems=$((problems + 1)); continue
  fi
  echo "    ok   $name ($(git -C "$path" rev-parse --short main), $(git -C "$path" tag | wc -l | tr -d ' ') tags)"
  TARGETS+=("$name")
done <<< "$REPO_LINES"
[ "$problems" -eq 0 ] || { echo "Refusing to publish: fix the $problems problem(s) above (re-run split.sh for a clean output)." >&2; exit 1; }
[ "${#TARGETS[@]}" -gt 0 ] || { echo "Nothing to publish." >&2; exit 1; }

if [ "$DRY_RUN" = false ]; then
  command -v gh >/dev/null || { echo "The GitHub CLI (gh) is required: https://cli.github.com" >&2; exit 1; }
  gh auth status >/dev/null 2>&1 || { echo "Run 'gh auth login' (scopes: repo, read:org) and 'gh auth setup-git' first." >&2; exit 1; }
fi

# ── Publish ──
declare -A CREATED=() VISIBILITY_NOTE=()
failures=()
for name in "${TARGETS[@]}"; do
  IFS=$'\t' read -r _ dir visibility has_issues has_discussions open_source _ < <(awk -F '\t' -v n="$name" '$1 == n' <<< "$REPO_LINES")
  path="$SPLIT_DIR/$dir"
  description=$(field "$name" description)
  homepage=$(field "$name" homepage)
  log "$ORG/$name"

  # 1. Create when missing, always private. Never touch the visibility of an existing repository.
  if [ "$DRY_RUN" = true ]; then
    echo "    (dry run) would check whether $ORG/$name exists and create it as private if not:"
    exists=no
  elif current=$(gh repo view "$ORG/$name" --json visibility --jq .visibility 2>/dev/null); then
    exists=yes
    echo "    exists ($current); visibility left unchanged"
    if [ "${current,,}" != "$visibility" ]; then
      VISIBILITY_NOTE[$name]="is $current, repos.json says $visibility (left unchanged)"
    fi
  else
    exists=no
  fi
  if [ "$exists" = no ]; then
    create=(gh repo create "$ORG/$name" --private --description "$description" --homepage "$homepage" --disable-wiki)
    [ "$has_issues" = true ] || create+=(--disable-issues)
    if run "${create[@]}"; then CREATED[$name]=1; else failures+=("$name: create failed"); continue; fi
  fi

  # 2. Push main and tags. No force: a diverged remote is reported, not overwritten.
  if [ "$PROTOCOL" = ssh ]; then url="git@github.com:$ORG/$name.git"; else url="https://github.com/$ORG/$name.git"; fi
  run git -C "$path" push "$url" refs/heads/main:refs/heads/main || { failures+=("$name: push of main rejected (remote diverged?)"); continue; }
  if [ -n "$(git -C "$path" tag)" ]; then
    run git -C "$path" push "$url" --tags || failures+=("$name: push of tags failed")
  fi

  # 3. Settings and metadata (same values every run).
  run gh repo edit "$ORG/$name" \
    --description "$description" \
    --homepage "$homepage" \
    --default-branch main \
    --enable-issues="$has_issues" \
    --enable-discussions="$has_discussions" \
    --enable-wiki=false \
    --delete-branch-on-merge \
    || failures+=("$name: settings not applied")
  if [ "$DRY_RUN" = true ]; then
    printf '    $ gh api --method PUT repos/%s/%s/topics --input - <<< %q\n' "$ORG" "$name" "$(topics_json "$name")"
  else
    topics_json "$name" | gh api --method PUT "repos/$ORG/$name/topics" --input - >/dev/null \
      || failures+=("$name: topics not applied")
  fi
  [ "$open_source" = true ] || echo "    note: $name stays private (not open source)"
done

# ── What is left to do by hand ──
log "Manual steps"
cat <<EOF
These cannot be done with the GitHub API or depend on a decision:

1. Social preview images (Settings > General > Social preview > Edit > Upload an image):
EOF
while IFS=$'\t' read -r name dir _ _ _ _ preview; do
  if [ "$preview" != "-" ] && [ "$dir" != "-" ] && printf '%s\n' "${TARGETS[@]}" | grep -qxF "$name"; then
    echo "     https://github.com/$ORG/$name/settings  <-  $SPLIT_DIR/$dir/$preview"
  fi
done <<< "$REPO_LINES"
cat <<EOF
2. Organization avatar (https://github.com/organizations/$ORG/settings/profile):
     $SPLIT_DIR/.github/profile/assets/org-avatar.png
3. Create the team @$ORG/maintainers; CODEOWNERS in every repository refers to it.
4. Branch protection or rulesets on main (require CI and one review). Private repositories need
   GitHub Team or Enterprise for this; on the Free plan apply them after a repository is public.
5. Visibility stays private. When a repository goes public (by hand, Settings > Danger zone):
     - make .github public too: the organization profile and the default community health
       files only apply from a public .github repository;
     - enable private vulnerability reporting (Settings > Code security);
     - create the Discussions categories (Q&A, Ideas, Show and tell, Announcements) in orkstage.
   orkstage-licensing is never made public.
6. Secrets and access:
     - orkstage-cli: AZURE_* and MACOS_* / APPLE_* signing secrets for signed releases;
     - orkstage-console: grant it read access to the @orkstage packages (package settings >
       Manage Actions access) and add the Dependabot secret DEPENDABOT_PACKAGES_TOKEN.
7. Mailboxes referenced by the community files: security@orkstage.io, conduct@orkstage.io,
   hello@orkstage.io.
EOF

if [ "${#VISIBILITY_NOTE[@]}" -gt 0 ]; then
  log "Visibility differs from repos.json (not changed)"
  for name in "${!VISIBILITY_NOTE[@]}"; do echo "    $name ${VISIBILITY_NOTE[$name]}"; done
fi
if [ "${#CREATED[@]}" -gt 0 ]; then log "Created: ${!CREATED[*]}"; fi
if [ "${#failures[@]}" -gt 0 ]; then
  log "Failures"
  printf '    %s\n' "${failures[@]}"
  exit 1
fi
[ "$DRY_RUN" = true ] && log "Dry run finished: nothing was created, pushed or changed."
exit 0
