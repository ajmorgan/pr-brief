# Review Brief — Skill Specification

> **Status:** v1.2 (2026-09-06, implemented at ~/.claude/skills/review-brief) — thirteen languages (§6.2a); links (§6.5a); viewer sidebar (§6.5b); same-work cache (§15); decisions through #14 (§11); open questions in §17
> **Purpose:** Let a human reviewer come up to speed on a body of agent-written changes, one file at a time, one function at a time, without reading raw diffs cold.

---

## 1. Problem

Agentic coding produces more change per hour than a person can hold in their head. Raw `git diff` shows *what lines* changed but not *what each function is for* or *what the change does to it*. Narrative tools (Diff Tours) let the agent choose what to talk about, which means the agent can skip, blur, or rationalize. The reviewer needs a brief whose **coverage is mechanical** and whose **prose is small and slotted**.

## 2. Principles

1. **The list of changed units is computed, never written.** A script derives files, functions, and hunks from git + a parser. The agent cannot add, drop, rename, or reorder a unit.
2. **File is the unit; function is the drill-down.** Every changed file gets a section. Inside it, every changed function/type gets an entry. Anything else in the file lands in a mandatory "other changes" bucket.
3. **Prose lives only in labelled slots with word budgets.** The agent fills each unit's `Purpose:` and `Changes:` (slot keys `does`/`change`; a deleted unit's `Purpose:` is key `did`), the file-level `Purpose:`/`Changes:`, and bullets. Nothing else.
4. **Descriptive, not justifying.** `Changes:` states what the code now does differently. "Why" is out of scope for v1 — the agent narrating its own work drifts into rationalizing.
5. **Nothing is dropped.** If a change cannot be attributed to a function, it still appears with its hunk. If a language is unsupported, the whole file appears as one unit and says so.
6. **Verifiable.** A lint confirms every slot is filled and the structure matches the skeleton.
7. **Executable by the agent without judgment calls.** The skeleton is the prompt, every slot carries its own instruction, done means lint exits 0 (§16).
8. **Incremental.** The brief carries its own cache (§15). A rerun re-narrates only units whose code changed, badges them, and never touches what the reviewer wrote.

## 2a. Reference point: Graphite Code Tours

Graphite's Code Tours ([announcement](https://graphite.com/blog/code-tours)) turn a PR into a linear guided walkthrough: narrative alongside the diff, generated from the PR description, review comments, the stack, and the code. Planned: visual artifacts for UI changes and surfacing relevant tests. It is hosted, post-PR, and the sequence is chosen by the model.

What this skill takes from it: the **upfront per-file blurb** — what the file is for and what the changes in it are meant to accomplish — before any code is shown, so the reviewer gets the map before the territory.

What this skill does differently: it runs **locally and pre-PR** (uncommitted work, or the branch before it is pushed); the set of files and functions is **computed, not chosen**; and the function-level text is **descriptive and checkable against the hunk** rather than narrative.

## 3. Non-goals (v1)

- Hunting for bugs (that is `/code-review`). The brief's `Review Observations:` slot records what a careful reader notices in passing; it is not a review pass.
- Rename/move detection (see §12).
- A viewer. Output is Markdown with `path:line` links; any editor or the terminal renders it.
- Explaining *why* a change was made.
- Languages beyond TypeScript/JavaScript and Java, except via the unsupported-file fallback.

## 4. Invocation

Four modes cover the real cases. Anything else is an escape hatch.

```
/review-brief                      # wip:    working tree (staged, unstaged, untracked) vs HEAD
/review-brief branch               # branch: merge-base(origin/main, HEAD) vs working tree
/review-brief all                  # all:    every tracked file vs the empty tree (brief a whole small repo)
/review-brief commit <ref>         # commit: parent(ref) → ref; files and callers read at ref
/review-brief -- <git diff args>   # escape hatch, passed through unchanged
```

- **wip** — "what did the agent just do." `git diff HEAD`.
- **branch** — "everything on this branch." Note the **merge-base**, not `origin/main..HEAD`: a two-dot diff against `origin/main` would include every upstream commit landed since you branched, shown as if you had reverted them. `git diff $(git merge-base origin/main HEAD)` shows only your side. It includes uncommitted work, because "the whole branch" as a reviewer means it. Base branch name is configurable (`--base <ref>`, default `origin/main`); the skill does not fetch — run `git fetch` first if the base may be stale.
- **commit** — one commit, for stepping through a history (`commit HEAD~3`, `commit <sha>`). The new side is the commit, not the working tree: the skeleton tells the agent to read files with `git show <sha>:<path>`, callers are found with `git grep` at that commit, and the snapshot is the commit itself. A root commit diffs against the empty tree.
- Options: `--base <ref>` (branch mode), `--path DIR` (limit the diff and the caller search), `--exclude PATHSPEC` (repeatable), `--no-untracked` (§14), `--full-fn-max N` (default 150; 0 = always the full body), `--out PATH` (default `REVIEW_BRIEF.md` at the repo root, §9a), `--list` (extraction only, prints the unit table §7 — no prose), `--fresh` (ignore every earlier brief and the cache; §15), `--check` (preflight only), `--section PATH` (print one file's section), `--open` (start the viewer, §18).

The brief file itself is always excluded from the diff (§6.1), otherwise the second run would describe the first.

## 4a. Preflight

Extract's first action, before touching git, is to verify its dependencies. Any failure is a **hard stop**: exit code 2, a message naming the missing tool and the exact install command, and nothing written. There is no degraded mode — the only possible fallback (the model guessing function boundaries) is what §2.1 forbids.

| check | how | on failure |
|---|---|---|
| `ast-grep` on `PATH` | `ast-grep --version` (the Homebrew formula installs both `ast-grep` and `sg`; check `ast-grep` first, `sg` second, and confirm `sg --version` mentions ast-grep — on Linux `sg` is also a setgroups utility) | `review-brief needs ast-grep. Install: brew install ast-grep  (or: npm i -g @ast-grep/cli, cargo install ast-grep)` |
| ast-grep minimum version | parse `--version`; minimum pinned during implementation to the version whose `scan --json` schema the rules were written against | `ast-grep <found> is too old; need >= <min>. brew upgrade ast-grep` |
| `git` on `PATH` and inside a work tree | `git rev-parse --is-inside-work-tree` | `review-brief must be run inside a git repository` |
| base ref resolves (branch mode) | `git rev-parse --verify <base>` | `<base> does not exist. Run git fetch, or pass --base <ref>` |
| script runtime | whichever of `node` / `bun` the scripts target | `review-brief scripts need node >= <min>` |

`extract --check` runs only the preflight and reports, so a user can verify a machine without generating anything.

**Agent behaviour on failure.** SKILL.md instructs the agent to run extract, and if it exits 2, to **stop and relay the message verbatim** — not to attempt the install (a system change is the user's action), not to substitute its own function detection, and not to produce a partial brief. The one thing the agent may add is the offer to re-run once the user says it is installed.

TypeScript, JavaScript, and Java grammars are compiled into the ast-grep binary; no per-language install is needed.

## 5. Pipeline

```
git diff -U0 <range>            ─┐
git show <base>:<path>           ├─►  extract.(sh|ts)  ─►  skeleton.md + units.json
git show <head>:<path> / worktree ┘         │
                                            ▼
                                   agent fills slots
                                            ▼
                                   lint.(sh|ts) ─►  REVIEW_BRIEF.md
```

- **extract** — deterministic. Runs preflight first (§4a; exit 2 on any missing dependency). Reads the existing `REVIEW_BRIEF.md` if present (§15), produces `units.json` (the fact table) and `skeleton.md` (the brief with slots either empty or pre-filled from the previous brief). This step never calls a model.
- **agent** — reads `skeleton.md`, the full new-side source of each changed file, and writes prose into slots. May read other files for context. May not edit anything outside a slot.
- **lint** — deterministic. Fails if any slot is empty, any heading was added/removed/reordered, or any word budget is exceeded. On failure the agent fixes and re-lints; the brief is not presented until lint passes.

## 6. Extraction algorithm

### 6.1 Changed ranges

```
git diff -U0 --no-color --no-ext-diff <range>
```

Parse each `@@ -oldStart,oldLen +newStart,newLen @@` header. For each file collect:

- `newRanges`: `[newStart, newStart+newLen)` for hunks with `newLen > 0`
- `oldRanges`: `[oldStart, oldStart+oldLen)` for hunks with `oldLen > 0`

Also record file status from `git diff --name-status <range>`: `A` (added), `D` (deleted), `M` (modified), `R` (renamed, treated as `D` + `A` in v1 — see §12), and whether git considers the file binary.

Whitespace-only hunks are kept (they still change lines) but the unit is tagged `whitespace-only` if `git diff -w` produces no hunk for it.

The output file (`REVIEW_BRIEF.md` or `--out`) is excluded via a pathspec (`-- . ':!REVIEW_BRIEF.md'`). On first run the skill offers to add it to `.git/info/exclude` (local, never committed) so it stays out of `git status` too.

### 6.2 Symbol tables

For each changed text file whose language has unit rules (§6.2a):

- Materialize **old** content: `git show <base>:<path>` (skip if status `A`).
- Materialize **new** content: `git show <head>:<path>`, or the working-tree file for the no-argument / `--staged` cases (skip if status `D`).
- Run `ast-grep scan -c <skill>/sgconfig.yml --json` over each side (`scripts/symbols.ts`), producing a list of symbols:

```json
{ "name": "save", "kind": "method", "scope": "OrderService",
  "start": 41, "end": 68, "signature": "public void save(Order o)" }
```

`start`/`end` are 1-based inclusive lines (ast-grep reports 0-based; convert); `start` is moved up over comment lines directly above the declaration. `signature` is the declaration on one line, cut at its body (§14 lists the per-language cut points). `scope` is the chain of enclosing named symbols (class, namespace, outer function) joined by `.`, decided on byte offsets so same-line symbols nest correctly; a rule may name it explicitly with `$SCOPE`.

### 6.2a Languages

Unit rules exist for TypeScript, TSX, JavaScript, Java, Python, Kotlin (`.kt`, `.kts`), Go, Lua, Bash, HTML, CSS, YAML and Markdown (`rules/<lang>/units.yml`, listed in `sgconfig.yml`, extensions in `LANG_BY_EXT`). Unit kinds per language: functions/methods/classes and their equivalents for code; for Go a method's unit is scoped by its receiver type; for HTML the units are elements with an `id` plus `<script>`/`<style>`; for CSS each rule set (named by selector) and `@media`/`@supports`/`@keyframes` blocks; for YAML mapping keys one and two levels deep plus list items carrying `name:` or `id:`; for Markdown sections named by heading, nesting by level. Rule ids are `<lang>-<kind>[.<variant>]`: the kind names the unit, a variant only selects another syntactic shape (a decorated Python function is still a `function`). A rule may capture `$SCOPE` to name a unit's scope explicitly; a rule that captures no `$NAME` gets a name from its kind or heading. Callers are searched only in languages with call syntax (not Bash, HTML, CSS, YAML, Markdown). Files in any other language are one whole-file unit with the file's diff (an added file capped at the full-body limit); the heading says "· whole file". ast-grep 0.45 also bundles Bash, C, C++, C#, CSS, Dart, Elixir, Haskell, HCL, Nix, PHP, Ruby, Rust, Scala, Solidity and Swift — each needs only a rules file to join. XML, Groovy/Gradle, TOML and SQL are not bundled and would need a custom tree-sitter grammar.

### 6.3 Attribution

For each file:

1. **Modified / new units.** For every `newRange`, find all new-side symbols whose `[start, end]` overlaps it. Take the **innermost** (smallest span). Union across ranges. A unit is:
   - `new` if no old-side symbol has the same `scope.name` and kind;
   - `modified` otherwise.
2. **Deleted units.** For every `oldRange`, find the innermost old-side symbol overlapping it. If no new-side symbol has the same `scope.name` and kind, the unit is `deleted`.
3. **Other changes.** Every `newRange` (and `oldRange` for pure deletions) not covered by any symbol at all becomes an `other` unit with its hunk. Typical contents: imports, top-level constants, comments outside functions, decorators on their own lines, package declarations.
4. **Container-only changes.** If a change overlaps a class/interface body but no member (e.g. a new field line, a changed `extends`), the innermost symbol is the container. It gets an entry of kind `class`/`interface`/… with only the hunk lines that are *not* inside a member. Members remain their own entries.

Ordering within a file: by `start` line on the new side; deleted units are placed at the position of their old `start` relative to the nearest surviving neighbour. Files are ordered by path (see §11).

Limitation: git diffs are line-based, so two symbols that share a line (a minified HTML line holding several elements, `class A { void m() {} }` on one line) cannot be told apart by the diff; the changed line is attributed to the innermost symbol by byte span, which may be the wrong one of the two. Nesting itself is decided on byte offsets and is correct; only same-line attribution is ambiguous.

### 6.4 Hunk selection per unit

- If the unit's new-side span is ≤ `--full-fn-max` lines, **or at least a third of its lines (old + new) changed**: emit the **whole function with changes marked** — i.e. `git diff -U<big> <range> -- <path>` clipped to `[start, end]`, so unchanged lines appear as context and changed lines carry `+`/`-`.
- Otherwise: emit the raw hunk(s) intersecting the unit, at `-U3`.
- Deleted units: the old-side body, all lines prefixed `-`.
- `other` units: the raw hunk at `-U3`.

### 6.5 Callers

For every `modified` and `deleted` unit of kind `function`/`method`/`constructor`/`arrow`, extract finds call sites across the repo on the new side (old side for deleted units):

- TS/JS: `call_expression` whose function is the identifier `name`, or a `member_expression` whose property is `name`; `new_expression` for classes.
- Java: `method_invocation` whose name is `name`; `object_creation_expression` for constructors.

Run as an ast-grep rule over the repo, restricted to the same language, excluding the unit's own definition. Result: a list of `path:line`, capped at 20 with a total count. This is **name-based, not type-resolved** — a common method name (`get`, `run`) will over-match. The list is labelled *Callers (by name)* so the reviewer knows what it is. Units with zero hits get `Callers: none found`.

Class-like units (`class`, `interface`, `enum`, `record`, `annotation`, `type`) are not called; they are referenced (`X.class`, `@X`, `new X(`, a type position). For those, extract runs `git grep` for the bare name across the repo (at the commit, or the working tree plus untracked files), skipping the declaring file and `import` lines, and labels the result *References (by name)* with the same cap and count.

The header's *Signature changes* line excludes units whose only signature difference is a rename; those are listed on a separate *Renamed* line (`old` → `new`).

### 6.5a Links

File headings, unit locations, "Other changes" bullets and caller/reference sites are relative Markdown links into the repository (`[\`path:26-48\`](path#L26)`). GitHub resolves them natively. The bundled viewer rewrites them to `?file=<path>&line=N`, which opens the file in the editor — read-only, at the version the brief describes (the commit in `commit` mode, otherwise the working tree, falling back to head then base for deleted files) — and jumps to the line. A plain click navigates in place (browser back returns to the brief); middle-click opens a new tab. Deleted files and `was path:a-b` locations are not linked.

### 6.5b Viewer sidebar

The viewer's sidebar stacks the open documents (brief plus jumped-into source files; read-only copies close without confirmation) above an outline of the active document. For a source file the outline is the list of symbols the same ast-grep rules find, served by `GET /file` as `symbols` with ids identical to the brief's unit ids, so symbols that are units in the brief carry a badge that links back to the unit; `]u`/`[u`, `:unit`, `:changed` ("in brief" filter) apply to both outlines. `POST /switch` carries the repository root so `/file` follows the brief.

### 6.6 Unsupported or unparseable files

If ast-grep has no grammar for the file, or parsing fails, the file gets **one** unit of kind `file`, tagged `unsupported-language` or `parse-error`, with the full diff at `-U3`. The file section says so explicitly. This is the only situation where a function-level breakdown is missing, and it is always labelled.

Binary files get a one-line section: path, status, byte sizes. No slots.

## 7. Unit table (`units.json`)

The fact table the agent and the lint both read. One record per unit:

| field | values |
|---|---|
| `path` | repo-relative |
| `fileStatus` | `A` `M` `D` `R` |
| `kind` | code: `function` `method` `constructor` `arrow` `class` `interface` `type` `enum` `record` `annotation` `object` `field` `const` `test` `block`; data and markup: `key` `item` `doc` `section` `rule` `element` `script` `style`; buckets: `other` `file` |
| `name` | symbol name, or `(imports)`, `(top-level)`, `(file)` for non-symbol units |
| `scope` | enclosing names, `.`-joined, may be empty |
| `status` | `new` `modified` `deleted` |
| `oldSpan` / `newSpan` | `[start, end]` or null |
| `signature` | the declaration on one line, cut at its body (§6.2) |
| `hunk` | the diff text per §6.4 |
| `callers` | `{ total, sites: ["path:line", …] }` per §6.5, or null |
| `tags` | subset of `whitespace-only` `container-only` `unsupported-language` `generated` `binary` |
| `hash` | sha256 prefix of the unit body (own lines only for container-only units and buckets) |
| `badge` | `updated since last` / `new since last` / empty |
| `renamedFrom` | old qualified name when the unit was paired as a rename, else null |

`--list` prints this as a table, one row per unit.

## 8. Language support

Superseded by §6.2a, which lists every language with rules and how the rule ids and metavariables work; the subsections below describe the first two languages in detail.

Rules are ast-grep YAML files under `rules/<lang>/`, one per kind. Each rule's `id` is the `kind` it reports. The name is captured from the node's `name` field where the grammar has one; for arrow functions it is the enclosing `variable_declarator`'s name.

### 8.1 TypeScript / JavaScript (`typescript`, `tsx`, `javascript`)

| kind | tree-sitter node | notes |
|---|---|---|
| `function` | `function_declaration`, `generator_function_declaration` | |
| `method` | `method_definition`, `method_signature` | inside `class_body` / `interface_body` |
| `arrow` | `arrow_function` or `function_expression` whose parent is `variable_declarator` or `public_field_definition` | name from the declarator / field |
| `class` | `class_declaration`, `abstract_class_declaration` | |
| `interface` | `interface_declaration` | |
| `type` | `type_alias_declaration` | |
| `enum` | `enum_declaration` | |

Anonymous callbacks (arrow functions passed as arguments) are **not** units; changes inside them attribute to the enclosing named symbol.

### 8.2 Java (`java`)

| kind | tree-sitter node |
|---|---|
| `method` | `method_declaration` |
| `constructor` | `constructor_declaration` |
| `class` | `class_declaration` |
| `interface` | `interface_declaration`, `annotation_type_declaration` |
| `enum` | `enum_declaration` |
| `record` | `record_declaration` |
| `field` | `field_declaration` |

Anonymous inner classes and lambdas attribute to the enclosing method.

### 8.3 Adding a language

Add `rules/<lang>/*.yml` and a line in the language→extension map. No other change. Node-kind names must be verified against the ast-grep version in use during implementation.

## 9. Output format

````markdown
# Review Brief — `<range>`

> - **Base** `<sha>` → **Head** `<sha>` [+ working tree]
> - **Files** N changed (a added, m modified, d deleted[, r renamed][, u untracked]) · **Units** M (n new, m modified, d deleted, o other)
> - **Commit** <subject> — <author>, <date>        (commit mode; a message up to three lines follows as sub-bullets)
> - **Signature changes** `OrderService.save`, `parseConfig` — or "none"
> - **Renamed** `old` → `new`                        (only when there are renames)
> - **Since last brief** …                           (only against a brief of the same work, §15)
>
> <details class="rb-meta"><summary>Commit message (N lines)</summary> … </details>   (messages longer than three lines)
> <details class="rb-meta"><summary>Agent instructions</summary>
>
> **Read these before filling any slot**[ — at commit `<sha>`, with `git show <sha>:<path>`]:
>
> - `path` …
>
> **Style:** concise and plain …
>
> </details>

**Overview:** <3–8 sentences: what the whole change set is trying to accomplish and how the files below divide the work — SLOT, written after every file section is complete>

---

## [`src/orders/OrderService.java`](src/orders/OrderService.java) — modified
<!-- rb:file path="…" hash="…" -->

**Purpose:** <1–2 sentences: what this file is responsible for — SLOT>

**Changes:** <2–5 sentences or bullets: what the changes in this file are meant to accomplish, and which units below carry them — SLOT>

**Review Observations:** <optional, ≤60 words — SLOT; the whole line is deleted when there is nothing to say>

**Other changes:**
- `OrderService.java:1-4` (imports) — <1 line — SLOT>
  ```diff
  <hunk>
  ```

### `save(Order o)` — modified · [`OrderService.java:41-68`](src/orders/OrderService.java#L41)[ · renamed from `x`][ · container only (members listed separately)][ · updated since last]
<!-- rb:unit id="…" kind="method" status="modified" hash="…" -->

**Callers (by name):** [`OrderController.java:88`](…), [`BatchImport.java:141`](…) (2)   ← generated, immutable; **References (by name):** for class-like units

**Purpose:** <≤40 words — SLOT; may say how the callers use it>

**Changes:** <≤60 words — SLOT>

**Review Observations:** <optional — SLOT>

```diff
<full function with changes marked, or hunk>
```

### `validate(Order o)` — new · `OrderService.java:70-84`

**Purpose:** <≤40 words — SLOT>

```diff
<all lines +>
```

### `legacySave(Order o)` — deleted · was `OrderService.java:90-110`

**Purpose:** <≤40 words — SLOT>

```diff
<all lines ->
```

---

## `config/app.yaml` — modified · whole file

**Purpose:** <SLOT>

**Changes:** <SLOT>

```diff
<full diff>
```
````

Rules:

- File sections are separated by a `---` horizontal rule, generated by extract.
- Three altitudes, top to bottom: **Overview** (the change set) → **Purpose / Changes** (the file) → **Purpose / Changes** (the unit). A reader may stop at any level; the labels are the same at both levels and the parser tells them apart by position.
- Heading text for files and units is generated by extract and is immutable. Paths and `path:start-end` locations are relative Markdown links (§6.5a); a unit heading whose display text contains backticks is wrapped in a longer backtick run.
- `Review Observations:` is optional under files and units: written only when there is something concrete to check, otherwise the line is deleted; once deleted in a filled brief it is not offered again until the unit changes.
- `new` units have `Purpose:` only. `deleted` units have `Purpose:` (past tense, deleted unit) only. `modified` units have both `Purpose:` and `Changes:`.
- **Added files have `Purpose:` only** — there is no "before", so `Changes:` is omitted; the file's units are all `new` and carry `Purpose:` only. The `Purpose:` instruction for an added file asks what it is for and who is expected to use it. Deleted files keep both (`Purpose:` in past tense, `Changes:` saying what was removed).
- `other` units have a single one-line slot.
- `Callers (by name):` / `References (by name):` lines are generated by extract and immutable.
- The top block is generated entirely by extract; **Signature changes** compares `signature` old vs new for modified units and excludes pure renames, which are listed under **Renamed**.

### 9a. Output location

`REVIEW_BRIEF.md` at the repository root. Rationale: a fixed, predictable name the reviewer opens by habit; a name unlikely to collide with anything a project already has (`REVIEW.md` is used by some repos for review guidelines); shouts what it is in a directory listing. It is regenerated on every run — it is a view, not a record. It is excluded from the diff (§6.1) and offered to `.git/info/exclude` so it never ends up in a commit. A copy is also printed to the terminal after the summary block, so the brief is in the session transcript.

The brief, like a Graphite tour, is meant to be read top to bottom: summary → file purpose → file changes → functions.

## 10. Prose rules (for the agent)

Three levels, and a fixed order of work.

**Order of work.** Fill every file section — `Purpose:`, `Changes:`, every unit's `Purpose:`/`Changes:`/`Purpose:` (past tense, deleted unit), every `other` line — **before** writing `Overview:`. The overview is a synthesis of the file sections, not a guess made before reading them; writing it last is what makes it accurate. The skeleton marks the slot `fill last`; SKILL.md places it as the final step before lint.

**Change-set level — the thesis.**
- `Overview:` — 3–8 sentences. What the whole change set is trying to accomplish, and how the files below divide that work (name the files or groups of files that carry each part). Intent is expected here. Written last.

**File level — the map. Intent is allowed here.**
- `Purpose:` — 1–2 sentences. What the file is responsible for, as it now stands.
- `Changes:` — 2–5 sentences or bullets. What the changes in this file are **meant to accomplish**, and which units below carry them. Must name every unit in the section (lint checks). This is where "why" lives.
- Added files: no `Changes:` slot. `Purpose:` carries the intent ("what it is for, who uses it"); each new unit's `Purpose:` carries the intended use of that function.

**Function level — the territory. Checkable against the hunk.**
- `Purpose:` — ≤40 words. The function as it now stands, for someone who has forgotten it exists. Present tense. May reference the generated callers line ("used by the controller and the batch importer to …").
- `Review Observations:` — optional, ≤60 words, under every unit and file. Concrete, checkable things a reviewer should look at: unreachable or redundant code, unused leftovers, a missing case, behaviour the description does not explain. Omitted (line deleted) when there is nothing; never "none". Keeps `Purpose:`/`Changes:` purely descriptive. The agent may be reviewing its own code here, so it complements rather than replaces `/code-review`.
- `Changes:` — ≤60 words. What the function now does that it did not, or no longer does — stated first, in terms the reviewer can verify by reading the hunk below. Name signature changes explicitly. A trailing clause on what the change is meant to accomplish is allowed *after* the behavioral description, never instead of it. If the intent and the code disagree, describe the code and say so.
- `Purpose:` (past tense, deleted unit) — ≤40 words. What the deleted function used to do; if the agent can see what replaced it, name the replacement.
- Write from the code, not from memory of intent. If the code and the intent disagree, describe the code.
- **Concise and plain.** Declarative sentences; no preamble, hedging, or filler; never restate the heading ("This function…", "is responsible for"). Budgets are ceilings, not targets — most slots need one sentence. The skeleton carries this as a `**Style:**` line above the first slot, and lint reports `STYLE` for a short list of filler and heading-restating phrases.
- Do not editorialize, do not summarize quality, do not recommend. That is a different skill.

## 11. Decisions

| # | decision | resolved | notes |
|---|---|---|---|
| 1 | full function vs hunk | full function when new-side span ≤ 150 lines or ≥ ⅓ of the body changed, else changed lines with 6 lines of context; the unit's location link opens the whole file | decided 2026-09-06 |
| 2 | file order | path order | confirmed as starting point; revisit after use |
| 3 | range | two named modes: `wip` (working tree vs HEAD) and `branch` (merge-base vs working tree); raw `git diff` args as escape hatch | see §4 on merge-base vs two-dot |
| 4 | callers | **in v1**, computed by extract, shown as an immutable line under each function heading; `Purpose:` may reference it | name-based, labelled as such |
| 5 | output | `REVIEW_BRIEF.md` at repo root, excluded from the diff, offered to `.git/info/exclude`; also echoed to terminal | §9a |
| 6 | intent / "why" | allowed at file level (`Changes:`); at function level only as a trailing clause after the behavioral description | §10 |
| 7 | file-level shape | `Purpose:` + `Changes:`, mirroring Graphite's upfront per-file blurb | §2a |
| 8 | name | `review-brief` (skill), `REVIEW_BRIEF.md` (output) | "tour" is taken twice (Graphite, Diff Tours); "brief" = read before the review; distinct from /code-review output |
| 9 | slot labels | `Purpose:` / `Changes:` at file and unit level; deleted units `Purpose:` in past tense | decided 2026-09-06; parser distinguishes by position; old labels still read |
| 10 | links | every path and location is a relative Markdown link; the viewer opens the file read-only at the briefed version | decided 2026-09-06 |
| 11 | summary block | blockquote of bullets with folded commit message and agent instructions | decided 2026-09-06 |
| 12 | languages | rules for TS, TSX, JS, Java, Python, Kotlin, Go, Lua, Bash, HTML, CSS, YAML, Markdown; **no** XML, Groovy or Gradle (custom grammars) | decided 2026-09-06 |
| 13 | unit layer stays language-agnostic | every symbol a rule finds is a unit; no per-language heuristics (accessor tagging etc.) in extraction | decided 2026-09-06 |
| 14 | since-last | computed only against a brief of the same work (same commit, or same mode); prose carries from any brief or the cache by hash | decided 2026-09-06 |

## 12. Edge cases

- **Renamed file (`R`)**: v1 treats as delete + add of the whole file. The two sections are placed adjacently and the header notes `renamed from <old path>`. Function-level attribution runs on the new path normally.
- **Renamed function**: appears as `deleted` + `new`, adjacent by position. Rename detection (normalized body equality) is v2.
- **Moved function** (same name, different file): two units, one deleted in the old file and one new in the new file. Lint does not attempt to link them.
- **Whitespace-only change** to a function: unit is kept, tagged `whitespace-only`; the agent may write `Changes:` as "formatting only" — the lint accepts that exact phrase under budget.
- **Generated files**: no special casing in v1. If a `.gitattributes` `linguist-generated` marker exists, extract tags the file `generated` and the file section collapses to the unsupported-language shape.
- **Very large diffs** (>200 units): extract still completes; the agent fills slots file by file. Nothing is truncated. If this is unusable in practice, the fix is narrowing the range, not dropping units.
- **New file**: every symbol in it is `new`; there is no old side. File section header says `added`.
- **Deleted file**: every symbol is `deleted`. `File:` slot is written in past tense.
- **Changes in a function's signature line only**: attributed to that function normally.
- **Overlapping symbols** (decorators, nested functions): innermost wins; the outer is not listed unless it has changes outside every inner symbol (§6.3.4).
- **Old-side parse fails but new-side succeeds** (or vice versa): units are computed from the side that parsed; the file is tagged `parse-error:old|new` and the header says so.

## 13. Future (not v1)

- **Type-resolved callers**: replace the name-based caller search (§6.5) with LSP or tsc/javac symbol resolution to remove false positives on common names.
- **Rename detection**: pair a `deleted` and a `new` unit whose normalized bodies match ≥ 90%.
- **`Why:` slot**, clearly separated from `Changes:`, sourced from commit messages when the range is committed.
- **Reviewer marks**: `- [ ] ok` / `- [ ] flag` per unit, and a companion `/review-brief-flags` that hands flagged units back to the agent.
- **More languages**: Python, Go, Zig, Rust — one rules directory each.
- **Ordering by call graph** or entry points.

## 14. Skill layout

```
review-brief/
  SKILL.md              # the five-step procedure the agent follows (§16)
  README.md             # for people
  sgconfig.yml          # ast-grep rule directories
  .gitattributes        # marks the vendored bundle and lockfile as generated
  scripts/
    extract.ts          # §6–7, §15; deps: git, ast-grep on PATH, node ≥ 22.18
    symbols.ts          # the symbol scanner shared by extract and the viewer server
    lint.ts             # §5 lint
    brief-format.ts     # the brief parser and budgets shared by extract and lint
    viewer.ts           # localhost server for the bundled editor (§18)
    selftest.sh         # fixture-based regression test
    sync-viewer.sh      # refreshes viewer/ from ~/code/web/editor
  rules/<lang>/units.yml   # typescript (+ units-tsx.yml), javascript, java, python, kotlin, go, lua, bash, html, css, yaml, markdown
  references/
    spec.md             # this document
    example-brief.md    # one real brief, regenerated from the fixture
  viewer/               # vendored xor editor: source + built vendor/editor.js, no node_modules
```

### 14.1 State (implementation)

Everything the pipeline keeps between runs lives under `.git/review-brief/`, so it is never in the diff, never in `git status`, and never committed:

| file | written by | purpose |
|---|---|---|
| `units.json` | extract | the fact table + expected headings + slot lock list; read by lint |
| `skeleton.md` | extract | copy of the skeleton as written |
| `previous.md` | extract | the brief that was on disk before this run |
| `last-<mode>.md` | lint | the last lint-clean brief per mode (`wip`, `branch`, `all`, `commit`, `raw`) |
| `cache.json` | lint | `id@hash → slots` for every unit ever described, `path@hash → purpose` per file, and for commit-mode briefs `overview@commit@<sha>` and `path@commit@<sha> → changes/review` |
| `refs/review-brief/previous` | extract | snapshot of the tree the last brief was generated from (`git stash create` when dirty), for the since-last hunk |

Carry-over sources, in priority: the brief on disk (if same mode), the same-mode archive, the other-mode archives, then `cache.json`; a source whose slots are still tokens (a skeleton regenerated before it was filled) is skipped. A unit whose body hash matches any source takes that source's prose. Consequences: switching `wip` ↔ `branch` costs nothing for units already described in either; reverting code to a previously described state costs nothing; file-level `Changes:` and `Notes:` come only from the primary source (they depend on which units are in the range), `Purpose:` from any.

Other implementation facts: overloads (two symbols with the same scope, name and kind on either side of the diff) carry their parameter list in the unit id, `Svc.save(Order o, boolean force)`, so each overload is its own unit; a container-only unit is hashed on its own changed lines only, so editing a member does not invalidate the container's prose; TS overload and `declare` signatures and abstract methods are units of their own; in working-tree modes (wip, branch, all, raw without `--staged`) untracked files are briefed as additions, `.gitignore` respected, unless `--no-untracked` is given; their since-last hunk is never available because `git stash create` cannot snapshot them; slot instructions never contain `>` (`›` is substituted) so `<<rb:… | …>>` is always delimited by the first `>>`; `other` units are bullets under `**Other changes:**` with their marker on the preceding line and their one-line slot after ` — `; a unit's `signature` is its whole declaration (annotation-only lines dropped, continuation lines joined) cut at the first `{`, `=>`, or `;`, so a changed parameter on a wrapped line is a signature change; comment lines directly above a declaration belong to it, not to the enclosing type; a type is *container-only* when its members are units in the same brief, whatever its kind; all import hunks of a file form one `path#(imports)` unit; the summary block is a blockquote of bullets (Base → Head, Files/Units, Commit, Signature changes, Renamed, Since last brief) followed by folded `<details>` blocks for a commit message longer than three lines and for the agent instructions (the read-these file list and the style line), so a reader sees one fact per line and the agent-only text stays collapsed on GitHub and in the viewer.

`SKILL.md` instructs the agent to: run extract (stop and relay verbatim on exit 2 — §4a) → read skeleton and the changed files → fill every file section (files in order, units in order) → write `Overview:` last → run lint → repeat until clean → print the path and the top summary block. The agent never generates headings, dividers, or hunks itself.

## 15. Incremental updates (cache)

**Same work only.** The since-last bookkeeping — badges, updated/new/removed counts, revise notes, the header line, the `previous:` front matter — is computed only against a previous brief of the *same work*: in commit mode the same commit; otherwise the same mode (a rebased base is still the same change set). Any other previous brief is ignored for that purpose, so briefing an unrelated commit never reports "300 commits since, everything new". Prose carry-over is independent of this: a unit's text is taken from any earlier brief or the cache whose unit body hash matches, and reviewer `Notes:` are never dropped (they get the *(code changed since this note)* prefix when the code moved).

**Commits are immutable.** On a clean lint of a commit-mode brief the cache also stores the overview and each file's Changes/Review Observations under the commit id, so briefing that commit again later — even after other briefs — costs no slots at all.

The brief is regenerated often — after the agent's next round of edits, after a rebase, after the reviewer has left notes. **Regeneration must not redo work already done.** On a 40-file brief where 3 files are new and 3 existing files changed, the agent writes prose for those 6 files' new and changed units only; the other 34 files (and the unchanged units within the 3 modified files) are carried over verbatim by extract, and lint forbids the agent from rewriting them. Nothing the reviewer wrote is ever discarded.

A side benefit: the heading badges let the reviewer skip straight to what changed since they last read.

### 15.1 What is recorded

**Front matter** at the top of `REVIEW_BRIEF.md`:

```yaml
---
review-brief: 1            # format version
mode: wip | branch | all | commit | raw
base: <sha>               # HEAD (wip), merge-base (branch), the empty tree (all), the parent (commit)
head: <sha>               # HEAD at generation
snapshot: <sha>           # commit-ish of the exact tree the brief was generated from (see below)
worktree: clean | dirty   # whether uncommitted changes were included
generated: <iso-8601>
previous:                 # from the brief this one was built from, or null
  head: <sha>
  snapshot: <sha>
---
```

`snapshot` is what makes "since last" work when the working tree is dirty: `HEAD` has not moved, but the code has. Extract creates it with `git stash create` (a commit object, no change to the tree or index; when the tree is clean it is simply `HEAD`) and pins it under `refs/review-brief/previous` so garbage collection cannot prune it. Only the latest snapshot is pinned; the previous ref is overwritten on each run.

**Per-section markers**, HTML comments immediately under each file and unit heading. Invisible when rendered; parsed by extract and checked by lint.

```html
<!-- rb:file path=src/orders/OrderService.java hash=<sha256 of new-side file content> -->
<!-- rb:unit id=src/orders/OrderService.java#OrderService.save kind=method status=modified hash=<sha256 of new-side unit body> -->
```

For deleted units the hash is of the old-side body. For `other` units the hash is of the hunk text. `id` is `path#scope.name`; for `other` units `path#(imports)` etc., disambiguated by the first line number if a file has several.

### 15.2 Hashes decide validity; commits and the snapshot guide the update

Two different questions:

**Which prose is stale?** — the unit hash. A commit cannot answer this: in `wip` mode the working tree changes while `HEAD` does not; after a rebase `base` and `head` both move while the code is identical. Comparing each unit's body hash against the previous brief is exact in both cases.

**What happened, and how should the prose change?** — the commits and the snapshot. For every rerun with a previous brief, extract computes:

- `git log --reverse previous.head..HEAD` — the new commits, with messages. Listed in the summary block for the reviewer, and given to the agent as the primary source of intent for file-level `Changes:`.
- For each *updated* unit, the **since-last hunk**: `git diff previous.snapshot -- <path>` clipped to the unit's span. This is the delta since the prose was last written, as distinct from the full hunk vs `base` that the reader sees. It is what the agent revises against.
- For each file with updated units, the subset of new commits that touched it (`git log previous.head..HEAD -- <path>`).

The skeleton presents these to the agent, per updated unit, as a revision note:

```markdown
<!-- rb:revise
previous Purpose: <text>
previous Changes: <text>
commits touching this file since last: <sha> <subject>; …
since-last hunk:
  <diff>
-->
```

The instruction is *revise using this*, not *rewrite*. The note is stripped by lint before the brief is final.

The reviewer's summary line becomes:

```
> **Since last brief:** 3 commits (<sha> <subject>, …) + uncommitted changes — u updated, n new, r removed, k unchanged
```

### 15.3 Carry-over rules

Extract reads the existing `REVIEW_BRIEF.md` (if present and its front matter parses) before writing the skeleton. For each unit in the new fact table:

| previous state | new state | result |
|---|---|---|
| same `id`, same `hash` | — | prose slots pre-filled from the previous brief; heading badge: none |
| same `id`, different `hash` | — | prose slots emptied, revision note attached (§15.2); heading badge **updated since last** |
| `id` absent previously | — | prose slots empty; heading badge **new since last** |
| `id` present previously | absent now | unit dropped from the brief; counted in the summary as *removed* |

Change-set level:
- `Overview:` carried over only if no unit is *updated*, *new*, or *removed*. Otherwise emptied with a revision note (previous overview, new commit subjects, list of updated/new/removed units) and written last, after the file sections are revised.

File level:
- `Purpose:` carried over, locked, while the file's content hash is unchanged; when the file changed it is reopened with a revise note holding the previous text, so the agent confirms or adjusts it rather than starting over.
- `Changes:` emptied if any unit in the file is *updated* or *new*, otherwise carried over.

The summary block gains a first line:

```
> - **Since last brief** N commits (first five subjects; … M more) [+ uncommitted changes] — u updated, n new, r removed, k unchanged [· range changed: …]
```

`--fresh` ignores any existing brief; every slot is empty and no badges are shown.

### 15.4 Reviewer notes

Every file section and unit entry has an optional slot the agent never writes:

```markdown
**Notes:** <reviewer-written; free text; may include - [ ] items>
```

Carry-over: always, verbatim, keyed by `id`. If the unit's hash changed since the note was written, the note is kept and prefixed with `*(code changed since this note)*`. Notes on removed units are collected under a final `## Orphaned notes` section rather than deleted. Lint treats `Notes:` as opaque: no budget, no requirement, but it must not be altered by the agent (lint compares against the previous brief).

A later companion (`/review-brief-flags`, §13) can hand every `Notes:` and unchecked `- [ ]` back to the agent as a work list.

### 15.5 Range changes

If the new run's `mode` or `base` differs from the previous front matter (e.g. `wip` yesterday, `branch` today; or a rebase moved the merge-base), carry-over still runs — hashes are content-based, so units that are byte-identical keep their prose. The summary notes `range changed: <old mode/base> → <new mode/base>` so the reviewer knows the headline delta is measured across a different baseline. After a rebase, `previous.head..HEAD` may list rewritten commits that contain no new code; the unit hashes will show 0 updated and the summary says so, so the commit list is informational rather than alarming.

### 15.6 Lint additions

- Every heading has exactly one `rb:` marker and markers match the fact table (ids, hashes, statuses).
- Carried-over slots are byte-identical to the previous brief unless the unit is *updated* or *new* (the agent may not silently rewrite prose for unchanged code; if it wants to, the reviewer asked for `--fresh`).
- `Notes:` slots are byte-identical to the previous brief, modulo the staleness prefix.
- Front matter `previous.head` / `previous.snapshot` equal the previous brief's `head` / `snapshot`.
- No `rb:revise` notes remain in the final brief.

## 16. LLM executability

The agent must be able to run this skill start to finish without ever having to decide what to do next, interpret an instruction, or ask a question. This is a requirement on the design of SKILL.md **and** of the skeleton, and it is testable (§16.6).

### 16.1 The skeleton is the prompt

The agent never reads this spec. Everything it needs is in the skeleton extract wrote, at the place it is needed:

- **Every slot is a unique, unmistakable token** carrying the unit id, so an edit cannot land in the wrong place and a slot cannot be confused with content:

  ```
  **Purpose:** <<rb:does src/orders/OrderService.java#OrderService.save | ≤40 words, present tense: what this function does now; may cite the callers line above>>
  **Changes:** <<rb:change src/orders/OrderService.java#OrderService.save | ≤60 words: what it now does that it did not, or no longer does — checkable against the hunk below; signature changes named; a trailing "meant to …" clause is allowed after the description>>
  ```

  The instruction travels with the slot. The agent does not have to remember §10 three thousand lines into a file.

- **Everything the agent must read is listed.** The skeleton opens with the list of new-side files to read (`Read these before filling any slot:`), so scoping is not a judgment call.
- **Order of work is written into the skeleton**, top to bottom, with the `Overview:` slot last and marked `fill last`.
- **Carried-over prose is not a slot.** It has no token; it is plain text. There is nothing for the agent to do with it, and lint rejects any change to it.
- **Revision notes (§15.2) sit directly under the slot they inform**, inside the `rb:revise` comment, and say: `Revise the previous text using the commits and hunk below.`

### 16.2 SKILL.md is a linear procedure

- Numbered steps. Each step is one command to run, or one thing to write, or one condition with exactly one action.
- The only branches are exit conditions: preflight failed → stop and relay; lint failed → fix the listed items and re-run lint. No "if the change is large, consider…".
- Commands are given verbatim with their arguments. The agent copies; it does not compose.
- Forbidden actions are listed concretely with the substitute action: *do not write headings — extract wrote them*; *do not add or remove units — if one seems missing, run `--list` and report the table*; *do not install tools — relay the message*; *do not edit carried-over text — it is locked*.
- No hedged vocabulary: no *consider*, *may*, *as appropriate*, *if needed*, *probably*, *try to*. Every sentence is imperative or declarative.

### 16.3 Success is mechanical

The agent is done when `lint` exits 0. Not "when the brief reads well." Lint output is an action list, one line per problem, each naming the slot token and the fix:

```
EMPTY   <<rb:change src/orders/OrderService.java#OrderService.save>>  — write it
BUDGET  <<rb:does src/x.ts#parse>>  71 words > 40 — shorten
LOCKED  src/y.ts#load Purpose: differs from previous brief — restore the previous text
STYLE   <<rb:does src/z.ts#run>>  "This function" restates the heading — cut it
MISSING file bullets for src/z.ts do not name unit `render`
```

The loop is: run lint → do exactly what each line says → run lint. Nothing else.

### 16.4 Resumable and context-safe

- All state is in files. If the agent's context is summarized or the session restarts mid-brief, `lint` lists the remaining empty slots and work continues; nothing is lost.
- The agent fills slots by **editing the skeleton in place**, one slot per edit, using the unique token as the match string. It never rewrites the whole file, so a 40-file brief does not have to fit in one output.
- Extract can emit the skeleton **one file section at a time** (`extract --section <path>`) for very large briefs; SKILL.md uses this mode above a unit-count threshold set in the skill, so the agent is not asked to hold the entire brief.

### 16.5 Triggering

The skill description is precise about when it applies (*"produce or update REVIEW_BRIEF.md for the current changes"*) and when it does not (*not for finding bugs — that is /code-review*), so it neither fires on the wrong request nor leaves the agent unsure whether to run it.

### 16.6 Test

A fixture repository with a known branch, a golden `units.json`, and a golden lint result. The eval runs `/review-brief branch` end to end and passes when: preflight passes, extract's unit table equals the golden, the agent reaches lint-clean without asking a question or running any command not in SKILL.md, and a second run on the unchanged fixture writes zero new prose. A second fixture with three added and three modified files checks that exactly those units are re-narrated.

## 18. Viewer (brief mode in xor)

The skill bundles a copy of xor, the editor (`viewer/`, synced from `~/code/web/editor` by `scripts/sync-viewer.sh`; `viewer/VENDORED` records the sync). The editor has a **brief mode** that activates for any document whose front matter starts `review-brief:`. The agent never uses it; it is the reviewer's surface.

### 18.1 How the brief reaches the editor

`extract --open` starts `scripts/viewer.ts`, a zero-dependency localhost server on the fixed port 8790, and opens `http://127.0.0.1:8790/?brief=/brief`. One server per machine: a second start hands its brief (and repository root) to the running one through `/switch` and exits, so the open tab follows. `--verbose` logs requests; `--stop` asks the running server to exit. The server serves `viewer/` statically (no-store) and exposes:

| route | does |
|---|---|
| `GET /brief` | current file content |
| `GET /brief/meta` | `{ path, name, mtime, viewer }` — `viewer` is the served app's build id; the editor reloads itself when it changes |
| `GET /events` | server-sent events: a `meta` frame (same JSON) on connect and whenever the brief file is rewritten, `/switch` changes the served brief, or `sw.js` is re-stamped. Open tabs hold one connection each and never poll; a dropped connection reconnects and gets the current meta again |
| `PUT /brief` | replaces the file; refused (422) unless the body starts with `review-brief:` front matter |
| `GET /file?path=` | a repository file as the brief sees it (the commit in commit mode, else the working tree, falling back to head then base), with its `symbols` for the outline |
| `POST /switch` | `{ path, root }` — serve another brief; localhost only |
| `POST /stop` | exit; localhost only |

The editor opens `?brief=` as a **remote document** (`{ remote: url, mtime }`): `:w` PUTs, `:rel` GETs. A brief opened from disk through the File System Access API (drag, ⌘O, OS "open with") behaves the same through its handle. The file on disk is the only truth; the editor's IndexedDB copy is a cache.

### 18.2 Two writers, one file

The agent rewrites the brief on every extract run; the reviewer edits it in the editor. Before writing, the editor compares the file's current `mtime` with the one recorded when it last read the file and **refuses to save** if they differ ("changed on disk — `:rel` first"). Reload discards unsaved editor changes, as `:e!` would; the reviewer's *saved* notes are safe because extract carries `**Notes:**` over by unit id (§15.4).

### 18.3 What brief mode adds

- **Outline** (sidebar): files → units with status and *updated/new since last* badges; click to jump; `changed` filter.
- **Motions and commands**: `]u` / `[u` next/previous unit (honouring the filter); `:unit <name>` / `:file <path>` (no argument → picker); `:note` puts the cursor on the unit's `**Notes:**` line in insert mode, creating the line after the unit's hunk if absent; `:changed` toggles the filter; `:rel` reloads.
- **Folded hunks**: every ```` ```diff ```` fence is folded on open in the editor (`zR`/`zM` as usual) and rendered as a collapsed `<details>` in the preview, so prose reads first.
- **Status**: `unit i/n · k changed`.
- **Copy as PR comment**: `:copy` (palette: *Brief: copy this unit as a PR comment*) or the copy icon on a unit heading in the preview writes the unit to the clipboard as Markdown and as HTML (one `ClipboardItem`, so a rich comment box keeps links and emphasis): the location line — `path:start-end`, linked to `<repo>/blob/<head>/<path>#Lstart-Lend` when the brief is in commit mode or the worktree is clean and the server found an origin remote — then the reviewer's `Notes:` with Purpose and Changes folded in a `<details>` under them, or Purpose and Changes unfolded when there are no Notes. `GET /brief/meta` and the `meta` event carry `repo` (the origin remote as a web URL, or null).
- **Scroll-spy**: in preview view, or in split view while the preview is the pane being scrolled, the outline highlight and the status follow the unit under the sticky file heading. Each unit renders in a `div.rb-unit` wrapper and each file in `section.rb-file`; both carry `data-spy-line` and tile the document, so an IntersectionObserver over a 2px band under the sticky heading knows exactly which one is being read without measuring on scroll. When the editor is the pane being scrolled, the cursor drives the outline as before.
- **Long briefs**: file cards use `content-visibility: auto` with a per-card size estimate (≈57px per block, hunks folded), so a 300-unit brief lays out only the cards near the viewport. Geometry inside a skipped card is not available: the preview uses the card's top for such blocks when mapping scroll positions, and forces a card visible for one frame before jumping into it (outline click, scroll sync, anchor link).
- **Sidebar**: the Open list (documents in the editor, × closes copies without confirmation, ⊗ closes the other opened files) above the Outline — the brief's files and units, or a source file's symbols with a `brief` badge on those that are units in the brief (§6.5b).
- **Preview**: front matter hidden; the summary block's folds; each file a card with a sticky heading and a status pill; hunks colourised in the file's language, unified or side by side (`:set diff=split`); every path a link that opens the file read-only at the briefed version in a new tab or in place (browser back restores the reader's position).

### 18.4 What the editor relies on (format contract)

Only these, all already required by §9 and §15: the front-matter gate line; `## \`path\` — status` file headings (the path may be wrapped in a Markdown link) followed by an `rb:file` marker; `### …` unit headings followed by an `rb:unit` marker (bullet units: marker then `- ` line); badge text `updated since last` / `new since last` in the heading or bullet; `**Purpose:**`, `**Changes:**`, `**Notes:**` as labelled slots; hunks as fenced `diff` blocks (fence length ≥ 3); relative links for paths. Nothing else in the brief is interpreted.

## 17. Open questions

1. ~~Default threshold~~ — decided 2026-09-06: 150 lines or one-third changed (deleted units always show their whole old body).
2. Should `field` (Java) and `type`/`interface` (TS) entries get `Purpose:` slots, or just the hunk? Default: `Purpose:` slot, ≤25 words.
4. ~~Trivial accessors (getters/setters) as full units~~ — decided 2026-09-06: they stay ordinary units with a `Purpose:` slot; no tagging or folding. Reason: the unit layer is language-agnostic — the ast-grep rules say what a symbol is, and every symbol is treated the same; an accessor detector would be a per-language shape heuristic inside extraction. (Also, a constant-returning override that looks like a getter is exactly what a reviewer wants described.)
3. ~~Untracked files in the working-tree case~~ — resolved 2026-09-06: included by default, `--no-untracked` excludes them.
4. Runtime for the scripts: Node/TypeScript (matches your stack) vs Bash+jq. Default: TypeScript, run with `node` or `bun`.
