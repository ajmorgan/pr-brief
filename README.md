# review-brief

A Claude Code skill that writes `REVIEW_BRIEF.md` — a per-file, per-function
brief of the current changes — so a human reviewer can come up to speed before
reading the diff. Not a bug finder.

```
/review-brief            # working tree vs HEAD
/review-brief branch     # whole branch vs merge-base with origin/main
/review-brief branch --base origin/develop
/review-brief --fresh    # ignore the previous brief
/review-brief --list     # just print the unit table, no prose
/review-brief commit HEAD~3   # one commit: its parent → itself
/review-brief --open     # also open the brief in the bundled editor
```

Requires `ast-grep` (`brew install ast-grep`), `git`, and `node >= 22.18` (the scripts are TypeScript run directly by node). The viewer needs nothing extra: it is a static, offline-capable copy of xor, the bundled editor, served from `viewer/`.

## Installing on another machine

Copy this directory to `~/.claude/skills/review-brief` (the commands in `SKILL.md` use that path) and install the three dependencies: `git`, `ast-grep` (`brew install ast-grep`), `node >= 22.18`. Nothing else: the viewer is a prebuilt static bundle, rules are plain YAML, and all state lives in each reviewed repository's `.git/review-brief/`. Run `node scripts/extract.ts --check` to confirm, `bash scripts/selftest.sh` to be sure.

## How it works

Working-tree modes brief untracked files too (`.gitignore` respected; `--no-untracked` turns it off), so an agent's new files show up without staging.

1. `scripts/extract.ts` — deterministic. `git diff -U0` gives changed line
   ranges; `ast-grep` (rules in `rules/`) gives every function/method/class
   with exact line spans on both the old and new side; the intersection is the
   unit list. It renders every heading, hunk, and callers line, carries over
   prose from the previous brief for units whose body hash is unchanged, and
   writes the skeleton to `REVIEW_BRIEF.md` with `<<rb:… | instruction>>` slots.
2. The agent fills the slots, one Edit each, following the instruction inside
   each slot.
3. `scripts/lint.ts` — deterministic. Checks every slot is filled, budgets
   hold, structure is untouched, carried-over text and reviewer `**Notes:**`
   are unchanged; strips revision notes; archives the clean brief per mode
   under `.git/review-brief/`.

The brief is its own cache: front matter records base/head/snapshot, and an
HTML-comment marker under each heading records the unit's content hash.

## Files

```
SKILL.md                 the agent's procedure
scripts/extract.ts       skeleton generator
scripts/lint.ts          verifier
scripts/brief-format.ts  shared parser
scripts/selftest.sh      builds a fixture repo and checks the unit table
scripts/viewer.ts        localhost server: serves viewer/ + GET/PUT /brief + GET /file
scripts/sync-viewer.sh   viewer/ ↔ ~/code/web/editor (pull by default, --push to publish the vendored copy)
viewer/                  vendored xor editor (vim mode, markdown preview, brief mode); VENDORED records the sync
rules/<lang>/units.yml   ast-grep rules per language (TypeScript, TSX, JavaScript, Java)
sgconfig.yml             ast-grep project config pointing at rules/
references/spec.md       the specification
references/example-brief.md
```

## Reading a brief

`/review-brief --open` (or `node scripts/viewer.ts`) serves the bundled editor
and opens the brief in **brief mode**: an outline of files and units in the
sidebar, hunks folded, vim throughout. `]u` / `[u` step through units, `:note`
adds your note to the unit under the cursor, `:changed` shows only units that
changed since the last brief, `:w` writes back to the file, `:rel` reloads it. `node scripts/viewer.ts --stop` stops the server.
Saving is refused if the file changed on disk since you opened it (the agent
regenerated it) — reload first. Your `**Notes:**` survive regeneration.

The sidebar stacks **Open** (the documents in the editor — the brief and the files you have jumped into; × closes, ⊗ closes the others, the title collapses the list) above the **Outline** of the active document: the brief's files and units, or a source file's symbols computed with the same ast-grep rules, badged `brief` when they are units in the brief (click the badge to open that unit). `]u`/`[u`, `:unit` and `:changed` work in both.

Every path in the brief is a link. In the preview, click one to open that file
in the editor at the line — read-only, at the version the brief describes
(the commit in `commit` mode, otherwise the working tree). Browser back
returns to the brief; middle-click opens the file in a new tab.

Languages with unit rules: TypeScript, TSX, JavaScript, Java, Python, Kotlin (incl. `.kts` build scripts), Go, Lua, Bash, HTML (elements with an id, script, style), CSS (rule sets, @-rules), YAML (keys two levels deep, named list items), Markdown (sections). Any other file type is briefed as a whole file — its diff under the file's Purpose/Changes.

Adding a language: add `rules/<lang>/units.yml` (one rule per unit kind, ids
prefixed `<lang>-`), list the directory in `sgconfig.yml`, and add the file
extensions to `LANG_BY_EXT` / `CALLER_LANGS` in `extract.ts`.
