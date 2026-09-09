---
name: pr-brief
description: |
  Produce or update a PR brief: a per-file, per-function brief of the
  current changes so a human can come up to speed before reviewing. Not for
  finding bugs — that is /code-review.
  Keywords:
  - PR brief, pr brief, review brief, brief me, catch me up on the changes
  - what changed per function, walk me through the diff
  - update the brief, regenerate the brief, pr-brief-<branch>.md
argument-hint: "[wip|branch|all|commit <ref>] [--base <ref>] [--fresh] [--no-untracked] [--key <name>] [--path <dir>] [--exclude <pathspec>]... [--full-fn-max <n>] [--out <path>] [--list] [--check] [--section <path>] [--open] [-- <git diff args>]"
user-invocable: true
allowed-tools: Read, Edit, Bash(node *), Bash(git *)
---

You are producing a PR brief for the human who will review the current
changes. A script computes every file, function, hunk, and heading. You write
prose into slots. You never decide what to include. The brief lives under the
repository's git directory as `pr-brief/<key>/pr-brief-<key>.md`, keyed by
the branch name or, for one commit, its short SHA; extract prints the path.

Skill directory: `~/.claude/skills/pr-brief`

## Procedure

Follow the steps in order. Each step is one command or one kind of edit.

### Step 1 — Generate the skeleton

Run exactly:

```
node ~/.claude/skills/pr-brief/scripts/extract.ts $ARGUMENTS
```

- Exit code **2**: a dependency is missing. Relay the script's message to the
  user verbatim. STOP. Do not install anything, do not write a brief by hand,
  do not detect functions yourself. When the user says it is installed, start
  again from Step 1.
- Exit code **1**: relay the error verbatim. STOP.
- Exit code **0** and the arguments contain `--list`, `--check` or
  `--section`: extract printed a table, a check or one file section and wrote
  nothing. Relay its output verbatim. STOP.
- Exit code **0** otherwise: it printed `wrote <path>: … N slots to fill`.
  `<path>` is the brief; Steps 2, 4 and 5 use it. Continue. If N is 0, go
  to Step 4.

`$ARGUMENTS` is passed through unchanged. `--open` makes extract start the
bundled viewer after writing; it does not change your steps.

### Step 2 — Read

Read the brief at `<path>`. Its summary block ends with a folded
`<details>` titled *Agent instructions* containing the line
`**Read these before filling any slot**` and, below it, one bullet per file —
Read every file listed there, in full. If that line says "at commit `<sha>`",
the working tree is not the version being briefed: read each file with
`git show <sha>:<path>` instead of Read. Do not read other files unless a
slot's text needs a definition that is not in the listed files.

### Step 3 — Fill the slots

A slot looks like this:

```
**Function Context:** <<rb:does src/x.ts#parse | step 1: concise summary, present tense: what this function does now>>
```

Everything between `<<` and `>>` is one slot: an id, a `|`, and the
instruction for that slot. Replace the entire `<<…>>` with your text,
following the instruction inside it and the `**Style:**` line in the summary
block. Use Edit with the exact `<<rb:… | …>>` string as the match; each one
is unique.

Rules for every slot:

1. Write only what the slot's own instruction asks for. No preamble, no
   hedging, no filler; never restate the heading ("This function…", "is
   responsible for").
2. A unit's `Changes:` is checkable against the hunk below the slot. A unit's
   `… Context:` describes the unit as it stands in the file you read in
   Step 2, not only the lines the hunk shows.
3. A slot's text may be a lead line followed by bullets, in any slot. The
   bullets start on the line directly after the label line, with no blank
   line anywhere in the slot: a blank line ends the slot, and text after it
   is lost on the next run.
4. `Review Observations:` is optional. Write only something concrete a
   reviewer should check. If there is nothing, delete the whole line; never
   write "none". Judgments go there and nowhere else: keep `… Context:` and
   `Changes:` purely descriptive.
5. A `<!-- rb:revise … -->` block under a slot means the code changed since
   the previous brief. It contains the previous text, the commits since, and
   the since-last hunk. Revise the previous text using them; do not start
   from scratch. Leave the block in place — lint removes it.
6. Text that is already present (no `<<…>>`) is carried over from the
   previous brief and is locked. Do not edit it.
7. `**Notes:**` lines are the reviewer's. Never edit, move, or remove them.

Do not:

- write, edit, or remove any heading, `---` divider, `<!-- rb:… -->` marker,
  `**Callers (by name):**` / `**References (by name):**` line, or ```diff block — extract wrote them;
- add or remove units — if one seems missing, run
  `node ~/.claude/skills/pr-brief/scripts/extract.ts --list $ARGUMENTS`
  and report the table to the user;
- rewrite the whole file — edit one slot at a time.

### Step 4 — Lint

Run exactly:

```
node ~/.claude/skills/pr-brief/scripts/lint.ts <path>
```

- Exit **0**: it printed `lint clean`. Go to Step 5.
- Exit **1**: it printed one line per problem, each starting with a code and
  ending with the fix. Do exactly what each line says, then run lint again.
  Codes: `EMPTY` write the slot, or, for a `Review Observations:` line that
  is empty or says "none", delete the whole line · `MISSING` name the unit in
  the file's Changes · `LOCKED` restore the carried-over text · `NOTES`
  restore the reviewer's note · `STYLE` cut the quoted filler phrase ·
  `STRUCTURE` restore the heading or marker exactly as written (re-run Step 1
  with the same arguments if you cannot; carried-over text is preserved), or
  delete the blank line between a label and its bullets.

Repeat until exit 0.

### Step 5 — Open and report

Run exactly:

```
node ~/.claude/skills/pr-brief/scripts/viewer.ts --detach --out <path>
```

It opens the brief in the default browser (starting the viewer in the
background, or handing the brief to the viewer already running and opening
a tab when none is connected), prints one line and returns. Do not act on
its output; a non-zero exit is not an error of the brief.

Then print, and nothing else:

1. The path `<path>`, as extract printed it.
2. The bullet lines of the summary block (the lines starting with `> -`),
   verbatim. Not the `<details>` parts.
3. The `**Overview:**` paragraph, verbatim.

## Reference

- `references/example-brief.md` — a finished brief.
