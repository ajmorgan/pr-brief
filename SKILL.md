---
name: review-brief
description: |
  Produce or update REVIEW_BRIEF.md: a per-file, per-function brief of the
  current changes so a human can come up to speed before reviewing. Not for
  finding bugs — that is /code-review.
  Keywords:
  - review brief, brief me, catch me up on the changes
  - what changed per function, walk me through the diff
  - REVIEW_BRIEF.md, update the brief
argument-hint: "[wip|branch|all|commit <ref>] [--base <ref>] [--fresh] [--no-untracked] [--list] [--open] [-- <git diff args>]"
user-invocable: true
allowed-tools: Read, Edit, Bash(node *), Bash(git *)
---

You are producing `REVIEW_BRIEF.md` for the human who will review the current
changes. A script computes every file, function, hunk, and heading. You write
prose into slots. You never decide what to include.

Skill directory: `~/.claude/skills/review-brief`

## Procedure

Follow the steps in order. Each step is one command or one kind of edit.

### Step 1 — Generate the skeleton

Run exactly:

```
node ~/.claude/skills/review-brief/scripts/extract.ts $ARGUMENTS
```

- Exit code **2**: a dependency is missing. Relay the script's message to the
  user verbatim. STOP. Do not install anything, do not write a brief by hand,
  do not detect functions yourself. When the user says it is installed, start
  again from Step 1.
- Exit code **1**: relay the error verbatim. STOP.
- Exit code **0**: it printed `wrote REVIEW_BRIEF.md: … N slots to fill`.
  Continue. If N is 0, go to Step 4.

`$ARGUMENTS` is passed through unchanged. With no arguments the brief covers
the working tree vs HEAD, untracked files included (`.gitignore` respected). `branch` covers the whole branch vs the merge-base
with `origin/main`. `all` covers every tracked file (the entire tree as one
set of additions) — use it to brief a whole small repository. `commit <ref>`
covers one commit (its parent → itself). `--open` makes
extract start the bundled viewer after writing; it does not change your steps.

### Step 2 — Read

Read `REVIEW_BRIEF.md`. Its summary block ends with a folded
`<details>` titled *Agent instructions* containing the line
`**Read these before filling any slot**` and, below it, one bullet per file —
Read every file listed there, in full. If that line says "at commit `<sha>`", the working tree is not the
version being briefed: read each file with `git show <sha>:<path>` instead of
Read. Do not read other files unless a slot's text needs a definition that is
not in the listed files.

### Step 3 — Fill the slots

A slot looks like this:

```
**Function Context:** <<rb:does src/x.ts#parse | ≤40 words, present tense: what this function does now>>
```

Everything between `<<` and `>>` is one slot: an id, a `|`, and the
instruction for that slot. Replace the entire `<<…>>` with your text,
following the instruction inside it. Work top to bottom through the file
sections. Use Edit with the exact `<<rb:… | …>>` string as the match; each
one is unique.

Rules for every slot:

1. Write only what the slot's own instruction asks for, within its word budget.
   Be concise and plain: declarative sentences, no preamble, no hedging, no
   filler, never restate the heading ("This function…"). Budgets are ceilings;
   most slots need one sentence.
2. A unit's `… Context:` / `Changes:` describe the code as it is in the hunk below
   the slot. If the intent and the code disagree, describe the code and say
   so in one clause.
3. A unit's `Changes:` states the behavioural difference first. A trailing clause on
   what it is meant to accomplish is allowed after that, never instead of it.
4. A file's `Changes:` must name every unit the instruction lists.
   `Review Observations:` is optional: write only something concrete a
   reviewer should check (unreachable or redundant code, an unused leftover,
   a missing case, behaviour the description does not explain). If there is
   nothing, delete that whole line. Never write "none". Keep `… Context:` and
   `Changes:` purely descriptive; judgments go here.
5. A `<!-- rb:revise … -->` block under a slot means the code changed since
   the previous brief. It contains the previous text, the commits since, and
   the since-last hunk. Revise the previous text using them; do not start
   from scratch. Leave the block in place — lint removes it.
6. Text that is already present (no `<<…>>`) is carried over from the
   previous brief and is locked. Do not edit it.
7. `**Notes:**` lines are the reviewer's. Never edit, move, or remove them.

Fill `**Overview:**` last, after every file section is complete. It is at the
top of the file and its slot says `fill LAST`. A change set with several
distinct parts gets one lead sentence and then a `- ` bullet per part,
directly under the lead with no blank line, each naming its files.

Do not:

- write, edit, or remove any heading, `---` divider, `<!-- rb:… -->` marker,
  `**Callers (by name):**` / `**References (by name):**` line, or ```diff block — extract wrote them;
- add or remove units — if one seems missing, run
  `node ~/.claude/skills/review-brief/scripts/extract.ts $ARGUMENTS --list`
  and report the table to the user;
- rewrite the whole file — edit one slot at a time.

### Step 4 — Lint

Run exactly:

```
node ~/.claude/skills/review-brief/scripts/lint.ts
```

- Exit **0**: it printed `lint clean`. Go to Step 5.
- Exit **1**: it printed one line per problem, each starting with a code and
  ending with the fix. Do exactly what each line says, then run lint again.
  Codes: `EMPTY` write the slot · `BUDGET` shorten to the limit · `MISSING`
  name the unit in the file's Changes · `LOCKED` restore the carried-over
  text · `NOTES` restore the reviewer's note · `STYLE` cut the quoted filler
  phrase · `STRUCTURE` restore the
  heading or marker exactly as written (re-run Step 1 with the same arguments
  if you cannot; carried-over text is preserved).

Repeat until exit 0.

### Step 5 — Report

Print, and nothing else:

1. The path `REVIEW_BRIEF.md`.
2. The bullet lines of the summary block (the lines starting with `> -`),
   verbatim. Not the `<details>` parts.
3. The `**Overview:**` paragraph, verbatim.

## Reference

- `references/spec.md` — the full specification (for humans; you do not need it).
- `references/example-brief.md` — a finished brief.
