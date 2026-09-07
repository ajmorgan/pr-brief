# pr-brief

A Claude Code skill that writes a PR brief — a per-file, per-function
brief of the current changes — so a human reviewer can come up to speed before
reading the diff. Not a bug finder.

```
/pr-brief            # working tree vs HEAD
/pr-brief branch     # whole branch vs merge-base with origin/main
/pr-brief branch --base origin/develop
/pr-brief all        # every tracked file vs the empty tree: brief a whole small repo
/pr-brief commit abc1234   # one commit, keyed by its short SHA
/pr-brief commit HEAD~3   # one commit: its parent → itself
/pr-brief -- --staged     # escape hatch: everything after -- goes to git diff
/pr-brief --fresh    # ignore the previous brief
/pr-brief --list     # just print the unit table, no prose
/pr-brief --key stack-v2   # name the brief yourself
/pr-brief --open     # also open the brief in the bundled editor
```

Narrowing and output flags: `--path <dir>` limits the diff and the caller search to one directory, `--exclude <pathspec>` (repeatable) drops paths, `--full-fn-max <n>` sets the line count above which a function shows only its changed lines (default 150; 0 always shows the whole body), `--out <path>` writes the brief somewhere other than the git directory, `--section <path>` prints one file's section as extract would write it, without writing anything, and `--check` runs only the dependency preflight. Spec §4 lists them all.

Requires `ast-grep` (`brew install ast-grep`), `git`, and `node >= 22.18` (the scripts are TypeScript run directly by node). The viewer needs nothing extra: it is a static, offline-capable copy of xor, the bundled editor, served from `viewer/`.

## Installing on another machine

Clone the repository to `~/.claude/skills/pr-brief` (the commands in `SKILL.md` use that path):

```sh
git clone git@github.com:ajmorgan/pr-brief.git ~/.claude/skills/pr-brief
```

Then install the three dependencies: `git`, `ast-grep` (`brew install ast-grep`), `node >= 22.18`. Nothing else: the viewer is a prebuilt static bundle, rules are plain YAML, and all state lives in each reviewed repository's `.git/pr-brief/`. Run `node scripts/extract.ts --check` to confirm, `bash scripts/selftest.sh` to be sure.

Two tests, both self-contained. `bash scripts/selftest.sh` builds a fixture repository and checks the extractor, carry-over, reviewer notes and lint. `node scripts/e2e.mjs` does the same for the viewer: it writes a brief per commit in its own fixture, serves them on port 8791, and drives Chrome through the outline, unit motions, ex commands, folds, file links at each brief's own commit, notes and saving, copy-as-PR-comment, closing, and the server's routes. Add `--headed` to watch it. It needs Playwright and Chrome; without them it says so and exits 0.

## How it works

Working-tree modes brief untracked files too (`.gitignore` respected; `--no-untracked` turns it off), so an agent's new files show up without staging.

1. `scripts/extract.ts` — deterministic. `git diff -U0` gives changed line
   ranges; `ast-grep` (rules in `rules/`) gives every function/method/class
   with exact line spans on both the old and new side; the intersection is the
   unit list. It renders every heading, hunk, and callers line, carries over
   prose from the previous brief for units whose body hash is unchanged, and
   writes the skeleton to `pr-brief-<key>.md` with `<<rb:… | instruction>>` slots.
2. The agent fills the slots, one Edit each, following the instruction inside
   each slot.
3. `scripts/lint.ts` — deterministic. Checks every slot is filled, structure is untouched, carried-over text and reviewer `**Notes:**`
   are unchanged, and no bullet list is stranded after a blank line under a label; strips revision notes; archives the clean brief beside it.

The brief is its own cache: front matter records base/head/snapshot, and an
HTML-comment marker under each heading records the unit's content hash.

## Files

```
SKILL.md                 the agent's procedure
scripts/extract.ts       skeleton generator
scripts/lint.ts          verifier
scripts/brief-format.ts  shared parser
scripts/symbols.ts       symbol scanner (ast-grep) shared by extract and the viewer server
scripts/selftest.sh      builds a fixture repo and checks the unit table
scripts/e2e.mjs          browser test of the viewer (needs Playwright and Chrome; optional)
scripts/viewer.ts        localhost server: serves viewer/ + GET/PUT /brief and /briefs/<key> + GET /file + POST /switch, /stop
viewer/                  the xor editor (vim mode, markdown preview, brief mode); this is its only copy
rules/<lang>/units.yml   ast-grep rules per language: eighteen directories, plus rules/typescript/units-tsx.yml for TSX
sgconfig.yml             ast-grep project config pointing at rules/
references/spec.md       the specification
references/example-brief.md
```

## Reading a brief

`/pr-brief --open` (or `node scripts/viewer.ts`) serves the bundled editor
and opens the brief in **brief mode**: an outline of files and units in the
sidebar that follows the preview as you scroll, hunks folded, vim throughout.
The tab updates itself the moment the brief is rewritten on disk (server-sent
events; only a brief opened from a local file still polls), and only the file
cards near the viewport are laid out, so a brief with hundreds of units stays
quick.

Brief-mode commands:

- `]u` / `[u` step through units; `:unit <name>` and `:file <path>` jump to one (no argument opens a picker).
- `:note` adds your note to the unit under the cursor. Your `**Notes:**` survive regeneration.
- `:copy` (or the copy icon on a unit heading in the preview) copies the unit as a PR comment: your Notes, with the brief's Context and Changes folded under them, and a link to the lines when the code is committed.
- `:changed` shows only units that changed since the last brief.
- `:w` writes back to the file; `:rel` reloads it. Saving is refused if the file changed on disk since you opened it (the agent regenerated it); the toast offers Reload, and `:rel` keeps any unsaved edits in a separate browser-only document named `<name> (your edits).md` before loading the new version.

`node scripts/viewer.ts --stop` stops the server. The server answers to
localhost only, and its writing routes trust two parties: the editor tab, and
processes that present the token it writes to `pr-brief-viewer-<port>.token`
in the OS temp directory (mode 0600, removed on exit) in the `X-Viewer-Token`
header. `POST /switch` and `POST /stop` always need the token; `PUT` needs it
when the request carries no `Origin`.

Where briefs live:

- Every brief is under the repository's git directory at `pr-brief/<key>/pr-brief-<key>.md`, with its own state beside it. Extract prints the path.
- The key is the branch name or, for `commit <ref>`, the commit's short SHA; `--key <name>` picks your own.
- Nothing lands in the working tree, so there is nothing to ignore and nothing to commit by accident. A stack of branches or a series of commits is a set of briefs side by side.
- In a linked worktree the briefs go to the main repository's `.git`; beside a bare clone they go to `.bare`. Every checkout of the repository sees the same set, and each brief remembers the worktree it was generated from.

Several briefs can be up at once. Every brief under the state directory joins
the served set at `/briefs/<key>`. The **Open** list shows every one of them,
each opens its files at its own commit, and × closes one for good in this
browser (asking for it by URL, or the next `--open`, brings it back). The next
`--open` adds a brief and brings it to the front.

The sidebar stacks **Open** above the **Outline**. Open holds the documents
in the editor: the brief and the files you have jumped into (× closes, ⊗
closes the others, the title collapses the list). Outline shows the active
document: the brief's files and units, or a source file's symbols computed
with the same ast-grep rules, badged `brief` when they are units in the brief
(click the badge to open that unit). `]u`/`[u`, `:unit` and `:changed` work
in both.

Every path in the brief is a link. In the preview, click one to open that file
in the editor at the line — read-only, at the version the brief describes
(the commit in `commit` mode, otherwise the working tree). Browser back
returns to the brief; middle-click opens the file in a new tab.

Languages with unit rules: TypeScript, TSX, JavaScript, Java, Python, Kotlin (incl. `.kts` build scripts), Go, Lua, C, C++, C#, Rust, Haskell, Bash, HTML (elements with an id, script, style), CSS (rule sets, @-rules), YAML and JSON (keys two levels deep, named list items), Markdown (sections). Any other file type is briefed as a whole file — its diff under the file's File Context/Changes.

Adding a language: add `rules/<lang>/units.yml` (one rule per unit kind, ids
prefixed `<lang>-`), list the directory in `sgconfig.yml`, and add the file
extensions to `LANG_BY_EXT` / `CALLER_LANGS` in `extract.ts`. A language whose
calls or declarations do not look like TS or Java also needs a `DECL_RE`
entry, a `callerPatterns` case and a reach rule in `restrictSites` there, and
any new unit kinds a word in `KIND_WORD` (`brief-format.ts`) and, if they are
referenced rather than called, a place in `TYPE_KINDS`; spec §8.3 lists the steps.
