# pr-brief

A Claude Code skill that turns a Git diff into a per-file, per-function brief
for human reviewers. It explains the change; it does not look for bugs.

```text
/pr-brief                     # working tree vs HEAD
/pr-brief branch              # merge-base(origin/main, HEAD) → working tree
/pr-brief branch --base origin/develop
/pr-brief all                 # entire working tree vs the empty tree
/pr-brief commit abc1234      # one commit, keyed by its short SHA
/pr-brief commit HEAD~3       # that commit's parent → that commit
/pr-brief -- --staged         # pass everything after -- to git diff
/pr-brief --fresh             # ignore previous brief prose
/pr-brief --list              # print the unit table; write nothing
/pr-brief --key stack-v2      # choose the brief key
/pr-brief --open              # open the skeleton while it is being filled
```

Working-tree modes include untracked files unless `--no-untracked` is set;
`.gitignore` is respected. Useful narrowing and output flags:

- `--path <dir>` limits the diff and caller search.
- `--exclude <pathspec>` drops a pathspec and may be repeated.
- `--full-fn-max <n>` shows only changed lines for functions longer than `n`
  lines (default 150; `0` always shows the full body).
- `--out <path>` changes the output path; `--section <path>`, `--list`, and
  `--check` inspect without writing a brief.

See [the specification](references/spec.md#4-invocation) for the complete CLI.

## Install

Requirements: `git`, `ast-grep`, and Node.js 22.18 or newer. On macOS,
`brew install ast-grep` installs the only nonstandard executable.

```sh
git clone https://github.com/ajmorgan/pr-brief.git ~/.claude/skills/pr-brief
cd ~/.claude/skills/pr-brief
node scripts/extract.ts --check
bash scripts/selftest.sh
```

The skill has no runtime package install: its ast-grep rules are YAML and the
offline viewer ships as static files with prebuilt dependency bundles.

The optional browser suite needs Playwright and Chrome:

```sh
npx playwright install chrome
node scripts/e2e.mjs --require   # add --headed to watch
```

## How it works

1. `scripts/extract.ts` deterministically combines `git diff -U0` ranges with
   ast-grep symbols from `rules/`. It writes every affected unit, hunk, caller,
   and a prose slot to `pr-brief-<key>.md`. Unchanged unit prose carries over by
   content hash.
2. Claude fills each slot without changing the generated structure.
3. `scripts/lint.ts` rejects empty slots, structural edits, changed reviewer
   notes, and invalid carried-over prose, then archives the clean brief.

Front matter records the compared revisions and snapshot. HTML markers record
unit hashes, making the brief its own incremental cache.

## Files

```text
SKILL.md                 agent procedure
scripts/extract.ts       deterministic skeleton generator
scripts/lint.ts          brief verifier and archive writer
scripts/brief-format.ts  shared brief parser
scripts/symbols.ts       symbol scanner shared by extract and viewer
scripts/selftest.sh      extractor and lint fixture suite
scripts/e2e.mjs          optional viewer browser suite
scripts/viewer.ts        localhost viewer server
viewer/                  xor sources and prebuilt third-party bundles
rules/<lang>/            ast-grep unit rules for 18 languages
sgconfig.yml             ast-grep project configuration
references/spec.md       the specification
references/example-brief.md
```

## Reading a brief

The skill opens the finished brief in the default browser. `--open` also opens
the skeleton while Claude fills it; `node scripts/viewer.ts` opens the latest
brief manually. An existing viewer receives the new brief instead of starting
a second server.

Brief mode provides a file-and-unit outline, folded hunks, vim motions, and
live updates when the brief changes on disk. File cards outside the viewport
are not laid out, so large briefs remain responsive.

Key commands:

- `]u` / `[u` move between units; `:unit <name>` and `:file <path>` jump directly.
- `:note` adds a reviewer note that survives regeneration.
- `:copy` copies the current unit as a PR comment, with a source link when available.
- `:changed` shows units changed since the previous brief.
- `:w` saves; `:rel` reloads. A save is refused when the source changed on disk.

Every path in the preview opens that source file read-only at the version the
brief describes: the selected commit in commit mode, otherwise the working
tree. Browser Back returns to the brief.

### Storage and server

- By default, briefs live under the repository's common Git directory at
  `pr-brief/<key>/pr-brief-<key>.md`; `--out` overrides this path.
- The key is the branch name, or the short SHA in commit mode. `--key`
  overrides it.
- Linked worktrees share the main repository's `.git`; worktrees beside a bare
  clone share `.bare`. Each brief retains the worktree where it was generated.
- All stored briefs join the viewer at `/briefs/<key>` and appear in **Open**.
  Each commit brief opens files at its own revision.

The server listens only on localhost. Process-level writes require a random
token stored as `pr-brief-viewer-<port>.token` in the OS temp directory with
mode 0600 and removed on exit. `node scripts/viewer.ts --stop` stops it.

### Supported languages

TypeScript, TSX, JavaScript, Java, Python, Kotlin (including `.kts`), Go, Lua,
C, C++, C#, Rust, Haskell, Bash, HTML, CSS, YAML, JSON, and Markdown have unit
rules. Other file types appear as one file-level unit.

See [spec §8.3](references/spec.md#83-adding-a-language) to add a language.
