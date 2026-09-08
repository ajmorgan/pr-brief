# PR Brief — Skill Specification

> **Status:** v1.3 (2026-09-07, implemented at ~/.claude/skills/pr-brief) — nineteen languages (§6.2a); links (§6.5a); viewer sidebar (§6.5b); same-work cache (§15); decisions through #14 (§11); open questions in §17
> **Purpose:** Let a human reviewer come up to speed on a body of agent-written changes, one file at a time, one function at a time, without reading raw diffs cold.

---

## 1. Problem

Agentic coding produces more change per hour than a person can hold in their head. Raw `git diff` shows *what lines* changed but not *what each function is for* or *what the change does to it*. Narrative tools (Diff Tours) let the agent choose what to talk about, which means the agent can skip, blur, or rationalize. The reviewer needs a brief whose **coverage is mechanical** and whose **prose is small and slotted**.

## 2. Principles

1. **The list of changed units is computed, never written.** A script derives files, functions, and hunks from git + a parser. The agent cannot add, drop, rename, or reorder a unit.
2. **File is the unit; function is the drill-down.** Every changed file gets a section. Inside it, every changed function/type gets an entry. Anything else in the file lands in a mandatory "other changes" bucket.
3. **Prose lives only in labelled slots.** The agent fills each unit's `<Kind> Context:` and `Changes:` (slot keys `does`/`change`; a deleted unit's `Context:` is key `did`), the file-level `Context:`/`Changes:`, and bullets. Nothing else.
4. **Descriptive, not justifying.** `Changes:` states what the code now does differently. "Why" is out of scope for v1 — the agent narrating its own work drifts into rationalizing.
5. **Nothing is dropped.** If a change cannot be attributed to a function, it still appears with its hunk. If a language is unsupported, the whole file appears as one unit and says so. The one exception is deliberate: in an added file, the license header, package line and import lines are not shown as a change to review (§6.3).
6. **Verifiable.** A lint confirms every slot is filled and the structure matches the skeleton.
7. **Executable by the agent without judgment calls.** The skeleton is the prompt, every slot carries its own instruction, done means lint exits 0 (§16).
8. **Incremental.** The brief carries its own cache (§15). A rerun re-narrates only units whose code changed, badges them, and never touches what the reviewer wrote.

## 2a. Reference point: Graphite Code Tours

Graphite's Code Tours ([announcement](https://graphite.com/blog/code-tours)) turn a PR into a linear guided walkthrough: narrative alongside the diff, generated from the PR description, review comments, the stack, and the code. Planned: visual artifacts for UI changes and surfacing relevant tests. It is hosted, post-PR, and the sequence is chosen by the model.

What this skill takes from it: the **upfront per-file blurb** — what the file is for and what the changes in it are meant to accomplish — before any code is shown, so the reviewer gets the map before the territory.

What this skill does differently: it runs **locally and pre-PR** (uncommitted work, or the branch before it is pushed); the set of files and functions is **computed, not chosen**; and the function-level text is **descriptive and checkable against the hunk** rather than narrative.

## 3. Non-goals (v1)

- Hunting for bugs (that is `/code-review`). The brief's `Review Observations:` slot records what a careful reader notices in passing; it is not a review pass.
- Semantic rename detection. Renamed files come from git (`-M`) and renamed units from a similarity heuristic (§12); nothing deeper.
- A hosted viewer. Output is Markdown with `path:line` links that GitHub, any editor or the terminal renders; the bundled editor (§18) is a local reader and note-taker for that same file, never a second copy of it.
- Explaining *why* a change was made.
- Languages without a rules directory (§6.2a lists the nineteen that have one); they get the whole-file fallback.

## 4. Invocation

Four modes cover the real cases. Anything else is an escape hatch.

```
/pr-brief                      # wip:    working tree (staged, unstaged, untracked) vs HEAD
/pr-brief branch               # branch: merge-base(origin/main, HEAD) vs working tree
/pr-brief all                  # all:    every tracked file vs the empty tree (brief a whole small repo)
/pr-brief commit <ref>         # commit: parent(ref) → ref; files and callers read at ref
/pr-brief -- <git diff args>   # escape hatch, passed through unchanged
```

- **wip** — "what did the agent just do." `git diff HEAD`.
- **branch** — "everything on this branch." Note the **merge-base**, not `origin/main..HEAD`: a two-dot diff against `origin/main` would include every upstream commit landed since you branched, shown as if you had reverted them. `git diff $(git merge-base origin/main HEAD)` shows only your side. It includes uncommitted work, because "the whole branch" as a reviewer means it. Base branch name is configurable (`--base <ref>`, default `origin/main`); the skill does not fetch — run `git fetch` first if the base may be stale.
- **commit** — one commit, for stepping through a history (`commit HEAD~3`, `commit <sha>`). The new side is the commit, not the working tree: the skeleton tells the agent to read files with `git show <sha>:<path>`, callers are found with `git grep` at that commit, and the snapshot is the commit itself. A root commit diffs against the empty tree.
- Options: `--base <ref>` (branch mode), `--key <name>` (name the brief; §9a), `--path DIR` (limit the diff and the caller search), `--exclude PATHSPEC` (repeatable), `--no-untracked` (§14), `--full-fn-max N` (default 150; 0 = always the full body), `--out PATH` (default `<git dir>/pr-brief/<key>/pr-brief-<key>.md`, §9a), `--list` (extraction only, prints the unit table §7 — no prose), `--fresh` (ignore every earlier brief and the cache; §15), `--check` (preflight only), `--section PATH` (print one file's section as it would be written; writes nothing), `--open` (start the viewer, §18).

The brief file itself is always excluded from the diff (§6.1), otherwise the second run would describe the first.

An option given without its value (`--key` as the last argument, `branch --base`, a value that starts with `-`), an unknown argument, or a non-numeric `--full-fn-max` exits **1** with the usage text. Exit 2 is reserved for a missing dependency (§4a).

## 4a. Preflight

Extract's first action, before touching git, is to verify its dependencies. Any failure is a **hard stop**: exit code 2, a message naming the missing tool and the exact install command, and nothing written. There is no degraded mode — the only possible fallback (the model guessing function boundaries) is what §2.1 forbids.

| check | how | on failure |
|---|---|---|
| `ast-grep` on `PATH` | `ast-grep --version` (the Homebrew formula installs both `ast-grep` and `sg`; check `ast-grep` first, `sg` second, and confirm `sg --version` mentions ast-grep — on Linux `sg` is also a setgroups utility) | `pr-brief needs ast-grep. Install: brew install ast-grep  (or: npm i -g @ast-grep/cli, cargo install ast-grep)` |
| ast-grep minimum version | parse `--version`; minimum pinned during implementation to the version whose `scan --json` schema the rules were written against | `ast-grep <found> is too old; need >= <min>. brew upgrade ast-grep` |
| `git` on `PATH` and inside a work tree | `git rev-parse --is-inside-work-tree` | `pr-brief must be run inside a git repository` |
| base ref resolves (branch mode) | `git rev-parse --verify <base>` | `<base> does not exist. Run git fetch, or pass --base <ref>` |
| script runtime | `node` ≥ 22.18 (`NODE_MIN` in `extract.ts`; the first version that strips types from a `.ts` file without a flag) | `pr-brief scripts need node >= 22.18` |

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
                                   lint.(sh|ts) ─►  pr-brief-<key>.md
```

- **extract** — deterministic. Runs preflight first (§4a; exit 2 on any missing dependency). Reads the existing brief if present (§15), produces `units.json` (the fact table) and `skeleton.md` (the brief with slots either empty or pre-filled from the previous brief). This step never calls a model.
- **agent** — reads the brief, the full new-side source of each changed file, and writes prose into slots. May read other files for context. May not edit anything outside a slot.
- **lint** — deterministic. Fails if any slot is empty, or any heading was added/removed/reordered. On failure the agent fixes and re-lints; the brief is not presented until lint passes.

## 6. Extraction algorithm

### 6.1 Changed ranges

```
git diff -U0 --no-color --no-ext-diff <range>
```

Parse each `@@ -oldStart,oldLen +newStart,newLen @@` header. For each file collect:

- `newRanges`: `[newStart, newStart+newLen)` for hunks with `newLen > 0`
- `oldRanges`: `[oldStart, oldStart+oldLen)` for hunks with `oldLen > 0`

Also record file status from `git diff --name-status <range>`: `A` (added), `D` (deleted), `M` (modified), `R` (renamed, paired by git `-M`: one section under the new path, `renamed from <old>` in its heading, old content read from the old path — see §12), and whether git considers the file binary. A type change (`T`, e.g. a file replaced by a symlink) is briefed as a modification and a copy (`C`) as an addition of the new path.

Whitespace-only hunks are kept (they still change lines) but the unit is tagged `whitespace-only` if `git diff -w` produces no hunk for it.

The brief lives under the git directory (§9a), outside the tree, so it needs no exclusion. A brief written into the tree with `--out` is excluded via a pathspec (`-- . ':!<path>'`) and, on first run, added to `info/exclude` (local, never committed) so it stays out of `git status` too.

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

Unit rules exist for TypeScript, TSX, JavaScript, Java, Python, Kotlin (`.kt`, `.kts`), Go, Lua, C (`.c`, `.h`), C++ (`.cpp`, `.cc`, `.cxx`, `.hpp`, `.hh`), C#, Rust, Haskell, Bash, HTML, CSS, YAML, JSON and Markdown (`rules/<lang>/units.yml`, listed in `sgconfig.yml`, extensions in `LANG_BY_EXT` — the same ones ast-grep maps, so a bare `.h` is C). Unit kinds per language: functions/methods/classes and their equivalents for code; for Go a method's unit is scoped by its receiver type; for HTML the units are elements with an `id` plus `<script>`/`<style>`; for CSS each rule set (named by selector) and `@media`/`@supports`/`@keyframes` blocks; for YAML and JSON mapping keys one and two levels deep plus list items carrying `name:` or `id:`; for Markdown sections named by heading, nesting by level. Rule ids are `<lang>-<kind>[.<variant>]`: the kind names the unit, a variant only selects another syntactic shape (a decorated Python function is still a `function`). A rule may capture `$SCOPE` to name a unit's scope explicitly; a rule that captures no `$NAME` gets a name from its kind or heading. Callers are searched only in languages with call syntax (not Bash, HTML, CSS, YAML, JSON, Markdown). Files in any other language are one whole-file unit with the file's diff (an added file capped at the full-body limit); the heading says "· whole file". ast-grep 0.45 also bundles Dart, Elixir, HCL, Nix, PHP, Ruby, Scala, Solidity and Swift — each needs only a rules file to join. XML, Groovy/Gradle, TOML and SQL are not bundled and would need a custom tree-sitter grammar.

Language notes for the six added in v1.3:

- **C / C++.** Kinds: `function`, `method`, `constructor`, `struct`, `class`, `union`, `enum`, `type` (typedef, `using X =`), `namespace`, `field`, `const` (file-level variables and object-like macros; a function-like macro is a `function`). A `typedef struct P { … } P;` is one unit named by its tag (by the typedef name when the struct is anonymous). An out-of-line C++ definition names its scope from the `Svc::` qualifier (`$SCOPE`; symbols.ts writes `::` as `.`), so it keys as `app.Svc.save`, and `Svc::Svc` is a constructor. Inside a class body the grammar names a definition with a plain identifier whether it is a constructor or a method, so the rules bind the class name and call a definition a constructor only when its name is the class's. A declaration without a body (a prototype, an in-class method declaration) is a unit only when its file does not also define it — for a member, `Class::name` with the declaring class as qualifier (`Outer::Inner::name`, `Box<T>::name` count; a generic argument list is dropped from the scope, so `Box<T>::get` keys as `Box.get`): a header's declarations are units, a static helper's prototype above its definition is not. A destructor (`~Svc`) or operator (`operator+`) has no identifier to search for, so it gets no Callers line. A `static` free function, at file or namespace level, is reachable only from its file (§6.5). A bare `f(x)` is not a statement of its own in these grammars, so the caller rules use ast-grep's `context`/`selector` pattern form, and C++ also searches `->` and `::` calls and `new Svc(`.
- **C#.** Kinds: `method`, `constructor` (destructors are a variant), `class`, `struct`, `interface`, `enum`, `record`, `delegate`, `namespace` (a block namespace; a file-scoped `namespace X;` has no body to contain), `field` (fields, events, properties, indexers). The operator token of an `operator +` declaration is anonymous in the grammar, so symbols.ts names it from the line (`operator+`, `operator int`). Attributes (`[Fact]`) are children of their declaration and belong to it. A local function is part of the method around it. `private` members are reachable only from their file.
- **Rust.** Kinds: `function` (free, in a `mod`), `method` (in an `impl` or `trait`; a trait's required signature too), `impl` (a container named from its head, "Server" or "Runner for Server", so its methods key as `Runner for Server.run`), `trait`, `struct`, `enum`, `union`, `type`, `module` (an inline `mod x { … }`), `const` (`const` and `static`), `macro`. Outer attributes on the lines above (`#[test]`, `#[derive]`) belong to the item. Callers include `Type::name(` calls. No visibility rule narrows a non-`pub` item's callers: private items are visible to child modules in other files.
- **Haskell.** Kinds: `function` (a signature, a `bind`, a `function` equation), `data` (`data`, `newtype`), `type` (a synonym), `class`, `instance` (a container named from its head, "Runner Color"). A top-level function is several sibling nodes (its signature and one per equation); symbols.ts merges adjacent same-named siblings into one unit that runs from the signature to the last equation and keeps the signature as its signature. `let`/`where` bindings belong to the enclosing function. A call has no parentheses, so the caller search matches any use of the name other than a declaration's own name position (`kind: variable` with a regex; `git grep` with a word boundary in commit mode, which cannot tell the two apart).
- **JSON.** Kinds: `key` (one and two levels deep; the quotes are stripped from the name), `item` (an array object carrying `"name"` or `"id"`). Attribution is line-based, so a one-line object credits the smallest key on that line; pretty-printed JSON (package.json, tsconfig) attributes correctly, minified JSON does not, and is usually generated anyway.

### 6.3 Attribution

For each file:

1. **Modified / new units.** For every `newRange`, find all new-side symbols whose `[start, end]` overlaps it. Take the **innermost** (smallest span). Union across ranges. A unit is:
   - `new` if no old-side symbol has the same `scope.name` and kind;
   - `modified` otherwise.
2. **Deleted units.** For every `oldRange`, find the innermost old-side symbol overlapping it. If no new-side symbol has the same `scope.name` and kind, the unit is `deleted`.
3. **Other changes.** Every `newRange` (and `oldRange` for pure deletions) not covered by any symbol at all becomes an `other` unit with its hunk. Typical contents: imports, comments outside functions, decorators on their own lines, package declarations; top-level constants are units wherever the language's rules have a `const` kind. Two refinements: in an added file the license header, package line and import lines are not collected (they are not a change to review), and a hunk of nothing but blank lines between symbols is collected and tagged `whitespace-only` so the file section never has slots over an empty diff.
4. **Container-only changes.** If a change overlaps a class/interface body but no member (e.g. a new field line, a changed `extends`), the innermost symbol is the container. It gets an entry of kind `class`/`interface`/… with only the hunk lines that are *not* inside a member. Members remain their own entries.

Ordering within a file: by `start` line on the new side; deleted units are placed at the position of their old `start` relative to the nearest surviving neighbour. Files are ordered by path (see §11).

Limitation: git diffs are line-based, so two symbols that share a line (a minified HTML line holding several elements, `class A { void m() {} }` on one line) cannot be told apart by the diff; the changed line is attributed to the innermost symbol by byte span, which may be the wrong one of the two. Nesting itself is decided on byte offsets and is correct; only same-line attribution is ambiguous.

### 6.4 Hunk selection per unit

- If the unit's new-side span is ≤ `--full-fn-max` lines, **or at least a third of its lines (old + new) changed**: emit the **whole function with changes marked** — i.e. `git diff -U<big> <range> -- <path>` clipped to `[start, end]`, so unchanged lines appear as context and changed lines carry `+`/`-`.
- Otherwise: emit the raw hunk(s) intersecting the unit, with 6 lines of context.
- Deleted units: the old-side body, all lines prefixed `-`.
- `other` units: the changed lines with 6 lines of context sliced from the file contents (not git's own context), restricted to the unit's own lines.

### 6.5 Callers

For every `modified` and `deleted` unit of kind `function`/`method`/`constructor`/`arrow`, in a language that has a call syntax to search (Bash, HTML, CSS, YAML, JSON and Markdown units carry no Callers line), extract finds call sites across the repo on the new side — for a deleted unit too, since the sites that remain are the ones now broken:

- TS/JS: `call_expression` whose function is the identifier `name`, or a `member_expression` whose property is `name`; `new_expression` for classes.
- Java: `method_invocation` whose name is `name`; `object_creation_expression` for constructors.
- C, C++, C#: the same shapes in ast-grep's `context`/`selector` pattern form, since a bare call is not a statement in those grammars; C++ and Rust also `->` and `Type::name(` calls; Haskell any use of the name outside a declaration's own name position (`callerPatterns` in `extract.ts`).

Run as an ast-grep rule over the repo, restricted to the same language, excluding the unit's own definition. Result: a list of `path:line`, capped at 20 with a total count. This is **name-based, not type-resolved** — a common method name (`get`, `run`) will over-match. The list is labelled *Callers (by name)* so the reviewer knows what it is. Two cheap corrections make the common wrong cases honest, and the line says when they applied: a declaration other files cannot call (a top-level function that is not `export`ed in TS/JS, a `private` member in Java, Kotlin or TS, an unexported name in Go) keeps only the sites that could reach it; and a file that declares the same name itself is taken to be calling its own, so its sites are dropped (`main` in three scripts lists one caller, not three). Units with zero hits get `Callers: none found`.

Class-like units (`class`, `interface`, `enum`, `record`, `annotation`, `type`) are not called; they are referenced (`X.class`, `@X`, `new X(`, a type position). For those, extract runs `git grep` for the bare name across the repo (at the commit, or the working tree plus untracked files), skipping the declaring file and `import` lines, and labels the result *References (by name)* with the same cap and count.

The header's *Signature changes* line excludes units whose only signature difference is a rename; those are listed on a separate *Renamed* line (`old` → `new`).

### 6.5a Links

File headings, unit locations, "Other changes" bullets and caller/reference sites are relative Markdown links into the repository (`[\`path:26-48\`](path#L26)`). GitHub resolves them natively. The bundled viewer rewrites them to `?file=<path>&line=N`, which opens the file in the editor — read-only, at the version the brief describes (the commit in `commit` mode, otherwise the working tree, falling back to head then base for deleted files) — and jumps to the line. A plain click navigates in place (browser back returns to the brief); middle-click opens a new tab. Deleted files and `was path:a-b` locations are not linked.

### 6.5b Viewer sidebar

The viewer's sidebar stacks the open documents (brief plus jumped-into source files; read-only copies close without confirmation) above an outline of the active document. For a source file the outline is the list of symbols the same ast-grep rules find, served by `GET /file` as `symbols` with ids identical to the brief's unit ids, so symbols that are units in the brief carry a badge that links back to the unit; `]u`/`[u`, `:unit`, `:changed` ("in brief" filter) apply to both outlines. `POST /switch` carries the repository root so `/file` follows the brief.

### 6.6 Unsupported or unparseable files

If ast-grep has no grammar for the file, the file gets **one** unit of kind `file`, tagged `unsupported-language`, with the full diff. The file section says so explicitly. This is the only situation where a function-level breakdown is missing, and it is always labelled. (tree-sitter parses error-tolerantly: a file with syntax errors still yields the units it could recover, and there is no parse-error tag.)

Binary files get a one-line section: `Binary file; <status>. No units.` No slots.

## 7. Unit table (`units.json`)

The fact table the agent and the lint both read. One record per unit:

| field | values |
|---|---|
| `path` | repo-relative |
| `fileStatus` | `A` `M` `D` `R` |
| `kind` | code: `function` `method` `constructor` `arrow` `class` `interface` `type` `enum` `record` `annotation` `object` `namespace` `field` `const` `test` `block` `struct` `union` `trait` `impl` `module` `macro` `data` `instance` `delegate`; data and markup: `key` `item` `doc` `section` `rule` `element` `script` `style`; buckets: `other` `file` |
| `name` | symbol name, or `(imports)`, `(top-level)`, `(file)` for non-symbol units |
| `scope` | enclosing names, `.`-joined, may be empty |
| `status` | `new` `modified` `deleted` |
| `oldSpan` / `newSpan` | `[start, end]` or null |
| `signature` | the declaration on one line, cut at its body (§6.2) |
| `hunk` | the diff text per §6.4 |
| `callers` | `{ total, sites: ["path:line", …], note? }` per §6.5, or null; `note` says which correction dropped sites |
| `tags` | subset of `whitespace-only` `container-only` `unsupported-language` `generated` `binary` |
| `hash` | sha256 prefix of the unit body (own lines only for container-only units and buckets) |
| `badge` | `changed since last` / empty — the unit is not what the previous brief of the same work showed (absent then, or a different body) |
| `renamedFrom` | old qualified name when the unit was paired as a rename, else null |

`--list` prints this as a table, one row per unit.

## 8. Language support

Superseded by §6.2a, which lists every language with rules and how the rule ids and metavariables work; the subsections below describe the first two languages in detail.

Rules are ast-grep YAML files under `rules/<lang>/`: one `units.yml` per language holding one rule per kind (TypeScript adds `units-tsx.yml`). Each rule's `id` is `<lang>-<kind>`, and the kind is what it reports. The name is captured from the node's `name` field where the grammar has one; for arrow functions it is the enclosing `variable_declarator`'s name.

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
| `interface` | `interface_declaration` |
| `annotation` | `annotation_type_declaration` |
| `enum` | `enum_declaration` |
| `record` | `record_declaration` |
| `field` | `field_declaration` |

Anonymous inner classes and lambdas attribute to the enclosing method.

### 8.3 Adding a language

Three steps, all required:

1. Add `rules/<lang>/units.yml` — one rule per unit kind, ids prefixed `<lang>-`.
2. List the new directory under `ruleDirs` in `sgconfig.yml`. `symbols.ts` runs `ast-grep scan -c sgconfig.yml`, so a directory not listed there is never scanned and the language falls to the whole-file fallback silently.
3. Add the file extensions to `LANG_BY_EXT` and, if the language has call syntax, `CALLER_LANGS` in `extract.ts`.

Node-kind names must be verified against the ast-grep version in use.

## 9. Output format

````markdown
# PR Brief — <key> · <range>          (the key names the brief, §9a: the branch as git spells it, a commit's short SHA, or --key; the range in words: working tree vs HEAD · branch vs <base> · entire tree · the commit's subject · git diff <args>)

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

**Overview:** <a concise lead line, then a concise bullet per distinct part naming its files (a short paragraph when there is one part) — SLOT, written last, from every file's Changes>

---

## [`src/orders/OrderService.java`](src/orders/OrderService.java) — modified
<!-- rb:file path="…" hash="…" -->

**File Context:** <concise summary: what this file does and owns, as it now stands — SLOT>

**Changes:** <concise enumeration of the unit updates below and what they accomplish, written from the unit Changes — SLOT>

**Review Observations:** <optional, concise — SLOT; the whole line is deleted when there is nothing to say>

**Other changes:**
- `OrderService.java:1-4` (imports) — <1 line — SLOT>
  ```diff
  <hunk>
  ```

### `save(Order o)` — modified · [`OrderService.java:41-68`](src/orders/OrderService.java#L41)[ · renamed from `x`][ · container only (members listed separately)][ · changed since last]
<!-- rb:unit id="…" kind="method" status="modified" hash="…" -->

**Callers (by name):** [`OrderController.java:88`](…), [`BatchImport.java:141`](…) (2)   ← generated, immutable; **References (by name):** for class-like units

**Method Context:** <concise summary — SLOT; may say how the callers use it>

**Changes:** <concise summary — SLOT>

**Review Observations:** <optional — SLOT>

```diff
<full function with changes marked, or hunk>
```

### `validate(Order o)` — new · `OrderService.java:70-84`

**Method Context:** <concise summary — SLOT>

```diff
<all lines +>
```

### `legacySave(Order o)` — deleted · was `OrderService.java:90-110`

**Method Context:** <concise summary — SLOT>

```diff
<all lines ->
```

---

## `config/app.yaml` — modified · whole file
<!-- rb:file path="config/app.yaml" hash="…" -->

**File Context:** <SLOT>

**Changes:** <SLOT>

<!-- rb:unit id="config/app.yaml#(file)" kind="file" status="modified" hash="…" -->
- `config/app.yaml` (whole file; no unit rules for this file type) — <one concise line — SLOT; an added file gets the fixed text `new file`>
```diff
<full diff>
```
````

Rules:

- File sections are separated by a `---` horizontal rule, generated by extract.
- Three altitudes, top to bottom: **Overview** (the change set) → **File Context / Changes** (the file) → **<Kind> Context / Changes** (the unit). A reader may stop at any level; the labels are the same at both levels and the parser tells them apart by position.
- Heading text for files and units is generated by extract and is immutable. Paths and `path:start-end` locations are relative Markdown links (§6.5a); a unit heading whose display text contains backticks is wrapped in a longer backtick run.
- `Review Observations:` is optional under files and units: written only when there is something concrete to check, otherwise the line is deleted; once deleted in a filled brief it is not offered again until the unit changes.
- `new` units have `Context:` only. `deleted` units have `Context:` (past tense, deleted unit) only. `modified` units have both `Context:` and `Changes:`.
- **Added files have `Context:` only** — there is no "before", so `Changes:` is omitted; the file's units are all `new` and carry `Context:` only. The `Context:` instruction for an added file asks what it is for and who is expected to use it. Deleted files keep both (`Context:` in past tense, `Changes:` saying what was removed).
- `other` units have a single one-line slot.
- `Callers (by name):` / `References (by name):` lines are generated by extract and immutable.
- The top block is generated entirely by extract; **Signature changes** compares `signature` old vs new for modified units and excludes pure renames, which are listed under **Renamed**.

### 9a. Output location

Every brief lives under the repository's **common git directory** — `.git` in a plain checkout, the main repository's `.git` for a linked worktree, `.bare` beside the worktrees of a bare clone — at `pr-brief/<key>/pr-brief-<key>.md`, next to its own state (§14.1). Extract finds that directory with `git rev-parse --path-format=absolute --git-common-dir` (the relative form, resolved against the top level, on git < 2.31) and prints the absolute path it wrote.

The **key** names the brief everywhere — its directory and file, the viewer's `/briefs/<key>` URL, the ref that pins its snapshot. A commit brief is keyed by the commit's short SHA (`git rev-parse --short=7`); any other brief by the branch it is on (the short SHA of HEAD when detached); `--key <name>` overrides both, for one brief standing for a whole stack. Keys are sanitised to `[A-Za-z0-9._-]` (a `/` in a branch name becomes `-`), so `adam/login` is `pr-brief-adam-login.md`.

Rationale: a brief is per-repository tool state, and the git directory is where git and its neighbours (Graphite, git-lfs, git-svn) keep exactly that. It is never in the diff, never in `git status`, never committed or pushed; each branch or commit keeps its own brief, so a stack is a set of briefs side by side; the worktrees of one repository share the set, and removing a worktree does not remove its brief. The brief records the worktree it was generated from (`root:` in the front matter), so the viewer reads its files from the right checkout wherever it was started. It is regenerated on every run — it is a view, not a record. `--out PATH` still writes anywhere; a brief written into the tree is excluded from the diff (§6.1) and offered to `info/exclude` so it never ends up in a commit. Extract prints one summary line to the terminal.

The brief, like a Graphite tour, is meant to be read top to bottom: summary → file purpose → file changes → functions.

## 10. Prose rules (for the agent)

Three levels, and a fixed order of work.

**Order of work.** Build upward, and every slot instruction names its step. Step 1: within each file section, the unit slots — every unit's `Context:`/`Changes:`/`Context:` (past tense, deleted unit), every `other` line, unit observations. Step 2: the file's `Changes:` from its unit `Changes:` (what they add up to), its `Context:`, and file-wide observations. Step 3: `Overview:` from every file's `Changes:` and the `Context:` of added files. Each level is a synthesis of the level below, not a guess made before reading it; that order is what makes it accurate. The instructions ask for concise text, never a count, and lint enforces no length.

**Change-set level — the thesis.**
- `Overview:` — a concise summary of all the changes, built from every file's `Changes:` and the `Context:` of added files: a concise lead line on what the whole change set accomplishes, then, when it has more than one distinct part, a concise bullet per part naming the files that carry it, with no blank line between the lead and the bullets. A single-part change set is a short paragraph instead.

**Bullets in any slot.** Every labelled slot may be a lead line followed by bullets, and the same shape rule applies everywhere: the list starts on the line directly after the label line, with no blank line anywhere in the slot. A blank line ends the slot; the parser ignores what follows and the next regeneration drops it. Lint reports a list stranded after a blank line under any label, so the text is never lost silently.

**File level — the map. Intent is allowed here.**
- `File Context:` — concise summary. What the file does and owns, as it now stands.
- `Changes:` — from the unit `Changes:` below: a concise enumeration, in sentences or concise bullets, of the unit updates and what they **add up to**; a file with one unit gets a concise summary of what it adds up to, not a restatement. Must name every unit in the section (lint checks). This is where "why" lives.
- Added files: no `Changes:` slot. `Context:` carries the intent ("what it is for, who uses it"); each new unit's `Context:` carries the intended use of that function.

**Function level — the territory. Checkable against the hunk.**
- `<Kind> Context:` (`Function Context:`, `Method Context:`, `Class Context:`, `Section Context:`, … from the unit's kind) — concise summary. The function as it now stands, for someone who has forgotten it exists. Present tense: what it does (a callable), says (a document section), or defines (anything else). May reference the generated callers line ("used by the controller and the batch importer to …").
- `Review Observations:` — optional, concise, under every unit and file (at file level, file-wide only: anything about one unit goes under that unit). Concrete, checkable things a reviewer should look at: unreachable or redundant code, unused leftovers, a missing case, behaviour the description does not explain, a consequence the change accepts (something no longer checked, a caller that must change). Omitted (line deleted) when there is nothing; never "none". Keeps `Context:`/`Changes:` purely descriptive. The agent may be reviewing its own code here, so it complements rather than replaces `/code-review`.
- `Changes:` — a concise summary, or a concise bullet per change when there is more than one (a list starts on the line after the label with no blank line; extract and lint put it there). What the function now does that it did not, or no longer does (for a document section or doc unit: what it now says that it did not, or no longer says; for a non-callable unit such as a type, field, key or rule: what it now defines that it did not, or no longer defines) — stated first, in terms the reviewer can verify by reading the hunk below. Name signature changes explicitly. A trailing clause on what the change is meant to accomplish is allowed *after* the behavioral description, never instead of it. If the intent and the code disagree, describe the code and say so.
- `<Kind> Context:` (past tense, deleted unit) — concise summary. What the deleted function used to do; if the agent can see what replaced it, name the replacement.
- Write from the code, not from memory of intent. If the code and the intent disagree, describe the code.
- **Concise and plain.** Declarative sentences; no preamble, hedging, or filler; never restate the heading ("This function…", "is responsible for"). The skeleton carries this as a `**Style:**` line above the first slot, and lint reports `STYLE` for a short list of filler and heading-restating phrases.
- Do not editorialize, do not summarize quality, do not recommend. That is a different skill.

## 11. Decisions

| # | decision | resolved | notes |
|---|---|---|---|
| 1 | full function vs hunk | full function when new-side span ≤ 150 lines or ≥ ⅓ of the body changed, else changed lines with 6 lines of context; the unit's location link opens the whole file | decided 2026-09-06 |
| 2 | file order | path order | confirmed as starting point; revisit after use |
| 3 | range | two named modes: `wip` (working tree vs HEAD) and `branch` (merge-base vs working tree); raw `git diff` args as escape hatch | see §4 on merge-base vs two-dot |
| 4 | callers | **in v1**, computed by extract, shown as an immutable line under each function heading; `Context:` may reference it | name-based, labelled as such |
| 5 | output | `<git dir>/pr-brief/<key>/pr-brief-<key>.md`, keyed by branch or short SHA, outside the tree; one summary line to the terminal naming the path. Was `PR_BRIEF.md` at the repo root until 2026-09-07 | §9a |
| 6 | intent / "why" | allowed at file level (`Changes:`); at function level only as a trailing clause after the behavioral description | §10 |
| 7 | file-level shape | `Context:` + `Changes:`, mirroring Graphite's upfront per-file blurb | §2a |
| 8 | name | `pr-brief` (skill), `pr-brief-<key>.md` (output) | "tour" is taken twice (Graphite, Diff Tours); "brief" = read before the review; distinct from /code-review output |
| 9 | slot labels | `File Context:` / `Changes:` on files; `<Kind> Context:` / `Changes:` on units, the word from the unit's kind (Function, Method, Class, Section, Key, Rule, …); deleted units' Context in past tense. Was Purpose:/Changes: until 2026-09-07 — the description is orientation for the reviewer, not the code's purpose, and the kind word tells them what they are reading | decided 2026-09-06; parser distinguishes by position; old labels still read |
| 10 | links | every path and location is a relative Markdown link; the viewer opens the file read-only at the briefed version | decided 2026-09-06 |
| 11 | summary block | blockquote of bullets with folded commit message and agent instructions | decided 2026-09-06 |
| 12 | languages | rules for TS, TSX, JS, Java, Python, Kotlin, Go, Lua, Bash, HTML, CSS, YAML, Markdown; **no** XML, Groovy or Gradle (custom grammars) | decided 2026-09-06 |
| 12a | languages | C, C++, C#, Rust, Haskell, JSON added (§6.2a); a bodyless declaration is a unit only when its file has no definition | decided 2026-09-07 |
| 13 | unit layer stays language-agnostic | every symbol a rule finds is a unit; no per-language heuristics (accessor tagging etc.) in extraction | decided 2026-09-06 |
| 14 | since-last | computed only against a brief of the same work (same commit; or same mode and none of the previous brief's files committed between the two bases); prose carries from any brief or the cache by hash | decided 2026-09-06, tightened 2026-09-07 |

## 12. Edge cases

- **Renamed file (`R`)**: git's rename detection (`-M`) pairs it. The brief has one section under the new path, its heading says `renamed from <old path>`, and the old content is read from the old path, so function-level attribution runs normally.
- **Renamed unit**: a `deleted` and a `new` unit of the same kind are paired when the deleted body has at least two lines beyond its signature (braces and annotations aside) and, after a word-boundary swap of the old name for the new, ≥90% of its trimmed lines are identical. The pair is one `modified` unit with `renamed from` in its heading, listed under **Renamed** in the summary and excluded from **Signature changes**. Boilerplate bodies (`return true;`, `TODO()`) never pair.
- **Moved function** (same name, different file): two units, one deleted in the old file and one new in the new file. Lint does not attempt to link them.
- **Whitespace-only change** to a function: unit is kept, tagged `whitespace-only`; the agent may write `Changes:` as "formatting only" — the lint accepts that exact phrase.
- **Generated files**: no special casing in v1. If a `.gitattributes` `linguist-generated` marker exists, extract tags the file `generated` and the file section collapses to the unsupported-language shape.
- **Very large diffs** (>200 units): extract still completes; the agent fills slots file by file. Nothing is truncated. If this is unusable in practice, the fix is narrowing the range, not dropping units.
- **New file**: every symbol in it is `new`; there is no old side. File section header says `added`.
- **Deleted file**: every symbol is `deleted`. `File:` slot is written in past tense.
- **Changes in a function's signature line only**: attributed to that function normally.
- **Overlapping symbols** (decorators, nested functions): innermost wins; the outer is not listed unless it has changes outside every inner symbol (§6.3.4).
- **Syntax errors on one side**: tree-sitter parses error-tolerantly, so units come from whatever each side recovered; there is no parse-error tag.

## 13. Future (not v1)

- **Type-resolved callers**: replace the name-based caller search (§6.5) with LSP or tsc/javac symbol resolution to remove false positives on common names.
- ~~Rename detection~~ — implemented, see §12.
- **`Why:` slot**, clearly separated from `Changes:`, sourced from commit messages when the range is committed.
- **Reviewer marks**: `- [ ] ok` / `- [ ] flag` per unit, and a companion `/pr-brief-flags` that hands flagged units back to the agent.
- **More languages**: Zig needs a custom grammar; Ruby, PHP, Swift, Scala, Dart, Elixir, HCL, Nix are bundled and need one rules directory each (§6.2a).
- **Ordering by call graph** or entry points.

## 14. Skill layout

```
pr-brief/
  SKILL.md              # the five-step procedure the agent follows (§16)
  README.md             # for people
  sgconfig.yml          # ast-grep rule directories
  .gitattributes        # marks the vendored bundle and lockfile as generated
  scripts/
    extract.ts          # §6–7, §15; deps: git, ast-grep on PATH, node ≥ 22.18
    symbols.ts          # the symbol scanner shared by extract and the viewer server
    lint.ts             # §5 lint
    brief-format.ts     # the brief parser shared by extract and lint
    viewer.ts           # localhost server for the bundled editor (§18)
    selftest.sh         # fixture-based regression test
    e2e.mjs             # fixture-based browser test of the viewer (§18); optional, needs Playwright
  rules/<lang>/units.yml   # typescript (+ units-tsx.yml), javascript, java, python, kotlin, go, lua, c, cpp, csharp, rust, haskell, bash, html, css, yaml, json, markdown
  references/
    spec.md             # this document
    example-brief.md    # one real brief, regenerated from the fixture
  viewer/               # vendored xor editor: source + built vendor/editor.js, no node_modules
```

### 14.1 State (implementation)

Everything the pipeline keeps between runs lives under `<common git dir>/pr-brief/` (§9a), so it is never in the diff, never in `git status`, and never committed. Each brief has its own directory, named by its key:

| file | written by | purpose |
|---|---|---|
| `<key>/pr-brief-<key>.md` | extract, agent, lint | the brief itself |
| `<key>/units.json` | extract | the fact table + expected headings + slot lock list, plus the brief's path, key and worktree; read by lint |
| `<key>/skeleton.md` | extract | copy of the skeleton as written |
| `<key>/previous.md` | extract | the brief that was on disk before this run |
| `<key>/last.md` | lint | the last lint-clean version of this brief |
| `last` | extract | the key of the brief written last: what `lint.ts` checks when given neither a path nor a key |
| `cache.json` | lint | shared by every brief of the repository: `id@hash → slots` for every unit ever described, `path@hash → purpose` per file, and for commit-mode briefs `overview@commit@<sha>` and `path@commit@<sha> → changes/review` |
| `refs/pr-brief/<key>` | extract | snapshot of the tree the brief was last generated from (`git stash create` when dirty), for the since-last hunk |

A repository briefed by an earlier version is migrated on the next run: `.git/review-brief/` is renamed to `pr-brief/`; a `PR_BRIEF.md` or `REVIEW_BRIEF.md` at the repository root moves under its key (the current branch, or the commit it describes) and its line leaves `info/exclude`; `commits/<sha>/PR_BRIEF.md` briefs move to `<sha>/pr-brief-<sha>.md`; the shared `units.json`, `skeleton.md` and `previous.md` are removed and the single snapshot ref dropped. The per-mode archives `last-<mode>.md` stay where they are and still feed carry-over. Readers accept both front-matter keys, so nothing is lost.

Carry-over sources, in priority: the brief on disk (if same mode), the key's `last.md`, the pre-key per-mode archives, then `cache.json`; a source whose slots are still tokens (a skeleton regenerated before it was filled) is skipped. A unit whose body hash matches any source takes that source's prose. Consequences: switching `wip` ↔ `branch` costs nothing for units already described in either; reverting code to a previously described state costs nothing; file-level `Changes:` and `Notes:` come only from the primary source (they depend on which units are in the range), `Context:` from any.

Other implementation facts:

- Overloads (two symbols with the same scope, name and kind on either side of the diff) carry their parameter list in the unit id, `Svc.save(Order o, boolean force)`, so each overload is its own unit.
- A container-only unit is hashed on its own changed lines only, so editing a member does not invalidate the container's prose.
- TS overload and `declare` signatures and abstract methods are units of their own.
- In working-tree modes (wip, branch, all, raw without `--staged`) untracked files are briefed as additions, `.gitignore` respected, unless `--no-untracked` is given. Their since-last hunk is never available because `git stash create` cannot snapshot them.
- Slot instructions never contain `>` (`›` is substituted), so `<<rb:… | …>>` is always delimited by the first `>>`.
- `other` units are bullets under `**Other changes:**` with their marker on the preceding line and their one-line slot after ` — `.
- A unit's `signature` is its whole declaration (annotation-only lines dropped, continuation lines joined) cut at the first `{`, `=>`, or `;`, so a changed parameter on a wrapped line is a signature change.
- Comment lines directly above a declaration belong to it, not to the enclosing type.
- A type is *container-only* when its members are units in the same brief, whatever its kind.
- All import hunks of a file form one `path#(imports)` unit.
- The summary block is a blockquote of bullets (Base → Head, Files/Units, Commit, Signature changes, Renamed, Since last brief) followed by folded `<details>` blocks for a commit message longer than three lines and for the agent instructions (the read-these file list and the style line), so a reader sees one fact per line and the agent-only text stays collapsed on GitHub and in the viewer.

`SKILL.md` instructs the agent to: run extract (stop and relay verbatim on exit 2 — §4a) → read skeleton and the changed files → fill every file section (files in order, units in order) → write `Overview:` last → run lint → repeat until clean → print the path and the top summary block. The agent never generates headings, dividers, or hunks itself.

## 15. Incremental updates (cache)

**Same work only.** The since-last bookkeeping — badges, changed/removed counts, revise notes, the header line, the `previous:` front matter — is computed only against a previous brief of the *same work*: in commit mode the same commit; otherwise the same mode, provided none of the previous brief's work has been committed since — the previous `base` is an ancestor of the current one and the commits between them touch none of the previous brief's files. A rebase or an amend rewrites history (the old base is no ancestor), and an unrelated commit moves the base without touching those files: both are still the same change set. Once the reviewed work lands in a commit, the next working-tree brief starts clean — no pills, no since-last line — while its prose still carries over by hash. Any other previous brief is ignored for that purpose, so briefing an unrelated commit never reports "300 commits since, everything new". Prose carry-over is independent of this: a unit's text is taken from any earlier brief or the cache whose unit body hash matches, and reviewer `Notes:` are never dropped (they get the *(code changed since this note)* prefix when the code moved).

**Commits are immutable.** On a clean lint of a commit-mode brief the cache also stores the overview and each file's Changes/Review Observations under the commit id, so briefing that commit again later — even after other briefs — costs no slots at all.

The brief is regenerated often — after the agent's next round of edits, after a rebase, after the reviewer has left notes. **Regeneration must not redo work already done.** On a 40-file brief where 3 files are new and 3 existing files changed, the agent writes prose for those 6 files' new and changed units only; the other 34 files (and the unchanged units within the 3 modified files) are carried over verbatim by extract, and lint forbids the agent from rewriting them. Nothing the reviewer wrote is ever discarded.

A side benefit: the heading badges let the reviewer skip straight to what changed since they last read.

### 15.1 What is recorded

**Front matter** at the top of the brief:

```yaml
---
pr-brief: 1            # format version
key: <key>                # the brief's name everywhere (§9a)
root: <abs path>          # the worktree it was generated from; the viewer reads files there
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

`snapshot` is what makes "since last" work when the working tree is dirty: `HEAD` has not moved, but the code has. Extract creates it with `git stash create` (a commit object, no change to the tree or index; when the tree is clean it is simply `HEAD`) and pins it under `refs/pr-brief/<key>` so garbage collection cannot prune it. Only the latest snapshot is pinned; the previous ref is overwritten on each run.

**Per-section markers**, HTML comments immediately under each file and unit heading. Invisible when rendered; parsed by extract and checked by lint.

```html
<!-- rb:file path="src/orders/OrderService.java" hash="<sha256 prefix of new-side file content>" -->
<!-- rb:unit id="src/orders/OrderService.java#OrderService.save" kind="method" status="modified" hash="<sha256 prefix of new-side unit body>" -->
```

The quotes are mandatory: extract writes every attribute as `name="value"`, and both parsers (`brief-format.ts` for extract and lint, the viewer's `brief.js`) match only that form. A marker with unquoted values parses to no attributes and lint reports `STRUCTURE`.

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
previous File Context: <text>
previous Changes: <text>
commits touching this file since last: <sha> <subject>; …
since-last hunk:
  <diff>
-->
```

The instruction is *revise using this*, not *rewrite*. The note is stripped by lint before the brief is final.

The reviewer's summary line becomes:

```
> **Since last brief:** 3 commits (<sha> <subject>, …) + uncommitted changes — c changed, r removed, k unchanged
```

### 15.3 Carry-over rules

Extract reads the existing brief (if present and its front matter parses) before writing the skeleton. For each unit in the new fact table:

| previous state | new state | result |
|---|---|---|
| same `id`, same `hash` | — | prose slots pre-filled from the previous brief; heading badge: none |
| same `id`, different `hash` | — | prose slots emptied, revision note attached (§15.2); heading badge **changed since last** |
| `id` absent previously | — | prose slots empty; heading badge **changed since last** |
| `id` present previously | absent now | unit dropped from the brief; counted in the summary as *removed* |

Change-set level:
- `Overview:` carried over only if no unit is *changed* or *removed*. Otherwise emptied with a revision note (previous overview, new commit subjects, list of changed/removed units) and written last, after the file sections are revised.

File level:
- `Context:` carried over, locked, while the file's content hash is unchanged; when the file changed it is reopened with a revise note holding the previous text, so the agent confirms or adjusts it rather than starting over.
- `Changes:` emptied if any unit in the file is *updated* or *new*, otherwise carried over.

The summary block gains a first line:

```
> - **Since last brief** N commits (first five subjects; … M more) [+ uncommitted changes] — c changed, r removed, k unchanged [· range changed: …]
```

`--fresh` ignores any existing brief; every slot is empty and no badges are shown.

### 15.4 Reviewer notes

Every file section and unit entry has an optional slot the agent never writes:

```markdown
**Notes:** <reviewer-written; free text; may include - [ ] items>
```

Carry-over: always, verbatim, keyed by `id`. If the unit's hash changed since the note was written, the note is kept and prefixed with `*(code changed since this note)*`. Notes on removed units are collected under a final `## Orphaned notes` section rather than deleted. Lint treats `Notes:` as opaque: no budget, no requirement, but it must not be altered by the agent (lint compares against the previous brief).

A later companion (`/pr-brief-flags`, §13) can hand every `Notes:` and unchecked `- [ ]` back to the agent as a work list.

### 15.5 Range changes

If the new run's `mode` or `base` differs from the previous front matter (e.g. `wip` yesterday, `branch` today; or a rebase moved the merge-base), carry-over still runs — hashes are content-based, so units that are byte-identical keep their prose. The summary notes `range changed: <old mode/base> → <new mode/base>` so the reviewer knows the headline delta is measured across a different baseline. After a rebase, `previous.head..HEAD` may list rewritten commits that contain no new code; the unit hashes will show 0 updated and the summary says so, so the commit list is informational rather than alarming.

### 15.6 Lint additions

- Every heading has exactly one `rb:` marker and markers match the fact table (ids, hashes, statuses).
- Carried-over slots are byte-identical to the previous brief unless the unit is *updated* or *new* (the agent may not silently rewrite prose for unchanged code; if it wants to, the reviewer asked for `--fresh`).
- `Notes:` slots are byte-identical to the previous brief, modulo the staleness prefix.
- The `previous:` front-matter block is informational; lint does not check it.
- No `rb:revise` notes remain in the final brief.

## 16. LLM executability

The agent must be able to run this skill start to finish without ever having to decide what to do next, interpret an instruction, or ask a question. This is a requirement on the design of SKILL.md **and** of the skeleton, and it is testable (§16.6).

### 16.1 The skeleton is the prompt

The agent never reads this spec. Everything it needs is in the skeleton extract wrote, at the place it is needed:

- **Every slot is a unique, unmistakable token** carrying the unit id, so an edit cannot land in the wrong place and a slot cannot be confused with content:

  ```
  **Method Context:** <<rb:does src/orders/OrderService.java#OrderService.save | concise summary, present tense: what this function does now; may cite the callers line above>>
  **Changes:** <<rb:change src/orders/OrderService.java#OrderService.save | concise summary: what it now does that it did not, or no longer does — checkable against the hunk below; signature changes named; a trailing "meant to …" clause is allowed after the description>>
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
LOCKED  src/y.ts#load Function Context: differs from previous brief — restore the previous text
STYLE   <<rb:does src/z.ts#run>>  "This function" restates the heading — cut it
MISSING file bullets for src/z.ts do not name unit `render`
```

The loop is: run lint → do exactly what each line says → run lint. Nothing else.

### 16.4 Resumable and context-safe

- All state is in files. If the agent's context is summarized or the session restarts mid-brief, `lint` lists the remaining empty slots and work continues; nothing is lost.
- The agent fills slots by **editing the skeleton in place**, one slot per edit, using the unique token as the match string. It never rewrites the whole file, so a 40-file brief does not have to fit in one output.
- Extract can print one file section as it would be written (`extract --section <path>`), for an agent that wants to work file by file. Like `--list` and `--check` it is read-only: it writes no brief, no state and no snapshot ref. SKILL.md does not use it by default — Step 1 relays the output of `--list`, `--check` and `--section` and stops.

### 16.5 Triggering

The skill description is precise about when it applies (*"produce or update a PR brief for the current changes"*) and when it does not (*not for finding bugs — that is /code-review*), so it neither fires on the wrong request nor leaves the agent unsure whether to run it.

### 16.6 Test

A fixture repository with a known branch, a golden `units.json`, and a golden lint result. The eval runs `/pr-brief branch` end to end and passes when: preflight passes, extract's unit table equals the golden, the agent reaches lint-clean without asking a question or running any command not in SKILL.md, and a second run on the unchanged fixture writes zero new prose. A second fixture with three added and three modified files checks that exactly those units are re-narrated.

## 17. Open questions

1. ~~Default threshold~~ — decided 2026-09-06: 150 lines or one-third changed (deleted units always show their whole old body).
2. Should `field` (Java) and `type`/`interface` (TS) entries get `Context:` slots, or just the hunk? Default: `Context:` slot, concise.
3. ~~Trivial accessors (getters/setters) as full units~~ — decided 2026-09-06: they stay ordinary units with a `Context:` slot; no tagging or folding. Reason: the unit layer is language-agnostic — the ast-grep rules say what a symbol is, and every symbol is treated the same; an accessor detector would be a per-language shape heuristic inside extraction. (Also, a constant-returning override that looks like a getter is exactly what a reviewer wants described.)
4. ~~Untracked files in the working-tree case~~ — resolved 2026-09-06: included by default, `--no-untracked` excludes them.
5. Runtime for the scripts: Node/TypeScript (matches your stack) vs Bash+jq. Default: TypeScript, run with `node` or `bun`.

## 18. Viewer (brief mode in xor)

The skill bundles xor, the editor (`viewer/`, developed in place; there is no other copy). The editor has a **brief mode** that activates for any document whose front matter starts `pr-brief:`. The agent never uses it; it is the reviewer's surface.

### 18.1 How the brief reaches the editor

`extract --open` starts `scripts/viewer.ts`, a zero-dependency localhost server on the fixed port 8790, and opens `http://127.0.0.1:8790/?brief=/briefs/<slug>`. One server per machine: a second start hands its brief (and repository root) to the running one through `/switch` and exits; the running server adds it to the set it serves and makes it current, and the open tab lists it and follows. Several briefs are served at once: every brief under a repository's state directory (`<common git dir>/pr-brief/<key>/pr-brief-<key>.md`, §9a) joins the set at `/briefs/<key>`, and each reads its files from the worktree recorded in its front matter. `--verbose` logs requests; `--stop` asks the running server to exit. The server serves `viewer/` statically (no-store) and exposes:

| route | does |
|---|---|
| `GET /brief` | current file content |
| `GET /brief/meta` | `{ path, name, mtime, viewer }` — `viewer` is the served app's build id; the editor reloads itself when it changes |
| `GET /events` | server-sent events: a `meta` frame (same JSON) on connect and whenever the brief file is rewritten, `/switch` changes the served brief, or `sw.js` is re-stamped. Open tabs hold one connection each and never poll; a dropped connection reconnects and gets the current meta again |
| `PUT /brief` | replaces the file; refused (422) unless the body starts with `pr-brief:` front matter; needs the token (below) when the request carries no `Origin` |
| `GET /file?path=&brief=` | a repository file as that brief sees it (the commit in commit mode, else the working tree, falling back to head then base), with its `symbols` for the outline; `brief` names the served brief (its commit, its repository), default the current one |
| `GET /briefs` | every served brief: `{ slug, url, path, name, mtime, repo, root }`; a stored brief's slug is its key, `root` the worktree it was generated from |
| `GET /briefs/<slug>`, `PUT /briefs/<slug>`, `GET /briefs/<slug>/meta` | one served brief, as `/brief` and `/brief/meta` are for the current one; the `meta` frame carries `current` and the `briefs` list |
| `POST /switch` | `{ path, root }` — add a brief (or find it) and make it current; token required |
| `POST /stop` | exit; token required |

**Trust.** The server answers to localhost only (a foreign `Host` gets 421, a `POST`/`PUT` with a foreign `Origin` gets 403), and its writing routes trust two parties. One is a tab of the editor, identified by a same-origin `Origin` header on its `PUT`. The other is this user's own processes — a second `viewer.ts` handing over a brief, `--stop`, a script saving a brief — which prove themselves with a per-process token: on start the server writes a random token to `<os.tmpdir()>/pr-brief-viewer-<port>.token` (mode 0600, removed on exit), and a client reads that file and sends the value in an `X-Viewer-Token` header. `POST /switch` and `POST /stop` always require the token; `PUT` requires it when the request carries no `Origin`. Any other local process — another user on a shared host — gets 403. `--stop` says so when it finds no token file for the port, since that server was not started by this user.

The editor opens `?brief=` as a **remote document** (`{ remote: url, mtime }`): `:w` PUTs, `:rel` GETs. A brief opened from disk through the File System Access API (drag, ⌘O, OS "open with") behaves the same through its handle. The file on disk is the only truth; the editor's IndexedDB copy is a cache.

### 18.2 Two writers, one file

The agent rewrites the brief on every extract run; the reviewer edits it in the editor. Before writing, the editor compares the file's current `mtime` with the one recorded when it last read the file and **refuses to save** if they differ. The toast reads "*name* changed on disk. Reload (:rel) to see the new version; your unsaved edits will be kept in a separate document." and offers a Reload action. Reload never drops unsaved edits: when the editor text differs from the file, it first saves that text as a browser-only document named `<name> (your edits).md` (IndexedDB, not on disk), then replaces the editor content with the file. The reviewer's *saved* notes are safe regardless, because extract carries `**Notes:**` over by unit id (§15.4).

### 18.3 What brief mode adds

- **Outline** (sidebar): files → units, each with one word, its status (new / modified / deleted / other); the word is highlighted as a pill on units the most recent set of changes touched (`changed since last` in the brief text); click to jump; `changed` filter shows only those.
- **Motions and commands**: `]u` / `[u` next/previous unit (honouring the filter); `:unit <name>` / `:file <path>` (no argument → picker); `:note` puts the cursor on the unit's `**Notes:**` line in insert mode, creating the line after the unit's hunk if absent; `:copy` copies the unit as a PR comment (below); `:changed` toggles the filter; `:rel` reloads.
- **Folded hunks**: every ```` ```diff ```` fence is folded on open in the editor (`zR`/`zM` as usual) and rendered as a collapsed `<details>` in the preview, so prose reads first.
- **Status**: `unit i/n · k changed`.
- **Copy as PR comment**: `:copy` (palette: *Brief: copy this unit as a PR comment*) or the copy icon on a unit heading in the preview writes the unit to the clipboard as Markdown and as HTML (one `ClipboardItem`, so a rich comment box keeps links and emphasis): the location line — `path:start-end`, linked to `<repo>/blob/<head>/<path>#Lstart-Lend` when the brief is in commit mode or the worktree is clean and the server found an origin remote — then the reviewer's `Notes:` with Context and Changes folded in a `<details>` under them, or Context and Changes unfolded when there are no Notes. `GET /brief/meta` and the `meta` event carry `repo` (the origin remote as a web URL, or null).
- **Scroll-spy**: in preview view, or in split view while the preview is the pane being scrolled, the outline highlight and the status follow the unit under the sticky file heading. Each unit renders in a `div.rb-unit` wrapper and each file in `section.rb-file`; both carry `data-spy-line` and tile the document, so an IntersectionObserver over a 2px band under the sticky heading knows exactly which one is being read without measuring on scroll. When the editor is the pane being scrolled, the cursor drives the outline as before.
- **Long briefs**: file cards use `content-visibility: auto` with a per-card size estimate (≈57px per block, hunks folded), so a 300-unit brief lays out only the cards near the viewport. Geometry inside a skipped card is not available: the preview uses the card's top for such blocks when mapping scroll positions, and forces a card visible for one frame before jumping into it (outline click, scroll sync, anchor link).
- **Sidebar**: the Open list (documents in the editor: every brief the server serves, so a series of commit briefs reads as a stack, plus the files jumped into; × closes a copy without confirmation and a closed brief stays closed for the page; ⊗ closes the opened files and keeps the briefs) above the Outline — the brief's files and units, or a source file's symbols with a `brief` badge on those that are units in the brief (§6.5b). Its right edge drags to resize it (`:set sidebar=<px>`, `sidebar=reset`; the width persists in settings), and a path longer than a row is clipped on the left so the file name stays visible, with the full path as a tooltip.
- **Preview**: front matter hidden; the summary block's folds; each file a card with a sticky heading and a status pill; hunks colourised in the file's language, unified or side by side (`:set diff=split`); every path a link that opens the file read-only at the briefed version in a new tab or in place (browser back restores the reader's position).

### 18.4 What the editor relies on (format contract)

Only these, all already required by §9 and §15: the front-matter gate line; `## \`path\` — status` file headings (the path may be wrapped in a Markdown link) followed by an `rb:file` marker; `### …` unit headings followed by an `rb:unit` marker (bullet units: marker then `- ` line); badge text `changed since last` in the heading or bullet; `**File Context:**` / `**<Kind> Context:**`, `**Changes:**`, `**Notes:**` as labelled slots; hunks as fenced `diff` blocks (fence length ≥ 3); relative links for paths. Nothing else in the brief is interpreted.
