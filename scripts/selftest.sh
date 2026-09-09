#!/usr/bin/env bash
# selftest.sh — builds a throwaway fixture repo and checks that extract produces the expected unit
# table (spec §16.6), that prose and reviewer notes carry over to the right units, and that lint
# passes a good brief and fails a bad one with the right code. Exit 0 on pass.
#
#   bash scripts/selftest.sh [--keep]     --keep leaves the fixture on disk for inspection
#
# The fixture is removed on success unless --keep is given; on failure it is always kept.
set -euo pipefail
KEEP=0; for arg in "$@"; do case "$arg" in --keep) KEEP=1 ;; *) echo "usage: selftest.sh [--keep]"; exit 1 ;; esac; done
# in-place sed on both GNU (Linux) and BSD (macOS) sed
sedi() { if sed --version >/dev/null 2>&1; then sed -i "$@"; else sed -i '' "$@"; fi; }
SK="$(cd "$(dirname "$0")/.." && pwd)"
FX="$(mktemp -d)/fixture"
mkdir -p "$FX/src" && cd "$FX" && FX="$(pwd -P)"   # real path: git reports real paths, and the checks below compare them
TMP="$(dirname "$FX")"                             # everything the test writes lives under here: never a fixed /tmp path
on_exit() {
  st=$?; trap - EXIT
  if [ "$st" -ne 0 ]; then echo "selftest FAILED (exit $st) — fixture kept at $FX"; exit "$st"; fi
  if [ "$KEEP" = 1 ]; then echo "selftest ok (fixture kept at $FX)"; else cd / && rm -rf "$TMP" && echo "selftest ok (fixture removed: $FX)"; fi
}
trap on_exit EXIT
git init -q -b main && git config user.email t@t && git config user.name t
# every brief lives under the repository's git directory, keyed by branch (or a commit's short SHA)
BRIEF="$FX/.git/pr-brief/main/pr-brief-main.md"

cat > src/Svc.java <<'EOF'
public class Svc {
    private final Repo repo;
    public Svc(Repo repo) { this.repo = repo; }
    public void save(Order o) {
        repo.put(o.id(), o);
    }
    public void legacy(Order o) { repo.putLegacy(o); }
}
EOF
cat > src/parse.ts <<'EOF'
import { readFileSync } from "fs";
export function parseConfig(path: string): Config {
  return JSON.parse(readFileSync(path, "utf-8"));
}
export const normalize = (c: Config): Config => ({ ...c, name: c.name.trim() });
export class Loader {
  load(p: string): Config { return normalize(parseConfig(p)); }
}
export interface Config { name: string; }
EOF
printf 'k: 1\n' > app.yaml
git add -A && git commit -qm base
BASE_SHA="$(git rev-parse HEAD)"

cat > src/Svc.java <<'EOF'
import java.util.Objects;
public class Svc {
    private final Repo repo;
    public Svc(Repo repo) { this.repo = repo; }
    public boolean save(Order o) {
        validate(o);
        repo.put(o.id(), o);
        return true;
    }
    private void validate(Order o) { Objects.requireNonNull(o.id()); }
}
EOF
cat > src/parse.ts <<'EOF'
import { readFileSync, existsSync } from "fs";
export function parseConfig(path: string): Config {
  if (!existsSync(path)) throw new Error("missing");
  return JSON.parse(readFileSync(path, "utf-8"));
}
export const normalize = (c: Config): Config => ({ ...c, name: c.name.trim().toLowerCase() });
export class Loader {
  load(p: string): Config { return normalize(parseConfig(p)); }
  size(): number { return 0; }
}
export interface Config { name: string; level?: number; }
EOF
printf 'k: 2\n' > app.yaml
printf 'export function fresh(): string { return "x"; }\n' > src/fresh.ts
git add src/Svc.java src/parse.ts app.yaml   # src/fresh.ts stays untracked: wip mode must still brief it

expected="modified key app.yaml#k
modified other src/Svc.java#(imports)
modified method src/Svc.java#Svc.save
deleted method src/Svc.java#Svc.legacy
new method src/Svc.java#Svc.validate
new function src/fresh.ts#fresh
modified other src/parse.ts#(imports)
modified function src/parse.ts#parseConfig
modified arrow src/parse.ts#normalize
new method src/parse.ts#Loader.size
modified interface src/parse.ts#Config"

actual="$(node "$SK/scripts/extract.ts" --list | awk '{print $1, $2, $3}')"
if [ "$actual" != "$expected" ]; then
  echo "FAIL: unit table differs"; echo "--- expected"; echo "$expected"; echo "--- actual"; echo "$actual"; exit 1
fi
case "$(node "$SK/scripts/extract.ts" --list --no-untracked)" in *fresh.ts*) echo "FAIL: --no-untracked still lists src/fresh.ts"; exit 1 ;; esac
# --section prints one file's section and, like --list, writes nothing: no state directory, no brief, no snapshot ref
out="$(node "$SK/scripts/extract.ts" --section src/parse.ts)"
case "$out" in '## [`src/parse.ts`](src/parse.ts)'*) ;; *) echo "FAIL: --section did not print the file's section: $out"; exit 1 ;; esac
[ ! -e .git/pr-brief ] || { echo "FAIL: --section wrote state under .git/pr-brief"; exit 1; }
git rev-parse -q --verify refs/pr-brief/main >/dev/null && { echo "FAIL: --section wrote the snapshot ref"; exit 1; }
# an option without its value is a usage error (exit 1), never a silent default or a 'missing dependency' exit 2
rc=0; node "$SK/scripts/extract.ts" --key >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 1 ] || { echo "FAIL: --key without a value exited $rc, expected 1"; exit 1; }
rc=0; node "$SK/scripts/extract.ts" branch --base >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 1 ] || { echo "FAIL: --base without a value exited $rc, expected 1"; exit 1; }
[ ! -e .git/pr-brief ] || { echo "FAIL: a usage error wrote state"; exit 1; }

# --- every rules language: one small file each, one edit each --------------------------
mkdir -p "$FX/lang" && cd "$FX/lang"
cat > a.py <<'EOF2'
LIMIT = 10
@decorator
def deco(x):
    return x
class Svc(Base):
    def save(self, o):
        def helper():
            return 1
        return helper()
EOF2
cat > b.kt <<'EOF2'
val TOP = 1
class Svc(private val repo: Repo) : Base() {
    constructor(x: Int) : this(Repo())
    fun save(o: Order) {
        fun local() = 2
        repo.put(o)
    }
    companion object { fun create() = Svc(Repo()) }
}
object Registry { fun get() = 1 }
EOF2
cat > c.go <<'EOF2'
package main
type Server struct { port int }
func (s *Server) Start() error { return nil }
func Run(a int) { }
EOF2
cat > d.lua <<'EOF2'
local M = {}
function M.save(o) return o end
local function helper(x)
  local function inner() return 1 end
  return x
end
M.load = function(p) return p end
EOF2
cat > e.sh <<'EOF2'
#!/usr/bin/env bash
ROOT="$(pwd)"
usage() { echo "u"; }
function build {
  echo b
}
EOF2
cat > f.html <<'EOF2'
<html><body>
<div id="app" class="x">
  <p>hi</p>
</div>
<script>var a=1;</script>
</body></html>
EOF2
cat > g.css <<'EOF2'
:root { --bg: #fff; }
@media (max-width: 800px) {
  .app { display: block; }
}
EOF2
cat > h.yml <<'EOF2'
spring:
  ldap:
    urls: x
server:
  port: 8080
steps:
  - name: checkout
    uses: actions/checkout@v4
EOF2
cat > i.md <<'EOF2'
# Title

## Section A

### Sub A1

body

## Section B
EOF2
cat > j.js <<'EOF2'
const LIMIT = 10;
function plain(a) { return a; }
const arrow = (x) => x + 1;
class Box {
  size() { return 0; }
}
module.exports = { plain, arrow, Box };
EOF2
cat > k.tsx <<'EOF2'
import React from "react";
export function App(): JSX.Element { return <div>hi</div>; }
export const Item = ({ n }: { n: number }) => <li>{n}</li>;
EOF2
cat > l.c <<'EOF2'
#define LIMIT 10
struct Point { int x, y; };
static int helper(int x);
int add(int a, int b) { return a + b; }
static int helper(int x) { return x; }
EOF2
cat > m.hpp <<'EOF2'
namespace app {
class Svc {
public:
    Svc(int p);
    Svc() : port_(0) {}
    int save(int o) const;
    int port() const { return port_; }
private:
    int port_;
};
}
EOF2
cat > m.cpp <<'EOF2'
#include "m.hpp"
namespace app {
Svc::Svc(int p) : port_(p) {}
int Svc::save(int o) const {
    auto f = [](int q) { return q; };
    return f(o);
}
template <typename T> T ident(T x) { return x; }
}
EOF2
cat > n.cs <<'EOF2'
namespace App {
    public record Order(int Id);
    public class Svc {
        private readonly int limit = 5;
        public Svc(int p) { }
        public bool Save(Order o) {
            int Local(int x) => x;
            return true;
        }
    }
}
EOF2
cat > o.rs <<'EOF2'
pub struct Server { port: u16 }
pub trait Runner { fn run(&self) -> bool; }
impl Server {
    pub fn new(port: u16) -> Self { Server { port } }
}
impl Runner for Server {
    fn run(&self) -> bool { true }
}
#[cfg(test)]
mod tests {
    #[test]
    fn it_works() { assert!(true); }
}
EOF2
cat > p.hs <<'EOF2'
module P where
data Color = Red | Green
fact :: Int -> Int
fact 0 = 1
fact n = n * fact (n - 1)
main :: IO ()
main = print (fact 3)
  where helper = 3
EOF2
cat > q.json <<'EOF2'
{
  "name": "pkg",
  "scripts": {
    "build": "node build.mjs",
    "test": "bash t.sh"
  },
  "workflows": [
    { "name": "ci", "on": "push" }
  ]
}
EOF2
cp -R "$FX/src" "$TMP/src-edited" && cp "$FX/app.yaml" "$TMP/app.yaml-edited"   # the wip change set, restored after the language commits
cd "$FX" && git add -A && git commit -qm langs
sedi 's/return helper()/return helper() + 1/' lang/a.py
sedi 's/repo.put(o)/repo.put(o); log(o)/' lang/b.kt; printf 'fun extra() = 3\n' >> lang/b.kt
sedi 's/return nil/return err/' lang/c.go
sedi 's/return x$/return x * 2/' lang/d.lua
sedi 's/echo b/echo built/' lang/e.sh
sedi 's/<p>hi<\/p>/<p>hello<\/p>/' lang/f.html
sedi 's/display: block;/display: flex;/' lang/g.css
sedi 's/urls: x/urls: y/' lang/h.yml
sedi 's/^body$/body text/' lang/i.md
sedi 's/return a;/return a + 1;/' lang/j.js
sedi 's/<div>hi<\/div>/<div>hello<\/div>/' lang/k.tsx
sedi 's/static int helper(int x) { return x; }/static int helper(int x) { return x + 1; }/' lang/l.c
sedi 's/return f(o);/return f(o) + 1;/' lang/m.cpp
sedi 's/return port_; }/return port_ + 0; }/; s/int port_;/int port_ = 0;/' lang/m.hpp   # an inline method and a field; the inline constructor and the declared save stay
sedi 's/return true;/return o != null;/' lang/n.cs
sedi 's/fn run(&self) -> bool { true }/fn run(\&self) -> bool { false }/' lang/o.rs
sedi 's/fact n = n \* fact (n - 1)/fact n = n * fact (n - 1) + 0/' lang/p.hs
sedi 's/"build": "node build.mjs"/"build": "node build.mjs --prod"/' lang/q.json
expected2="modified function lang/a.py#Svc.save
modified function lang/b.kt#Svc.save
new function lang/b.kt#extra
modified method lang/c.go#Server.Start
modified function lang/d.lua#helper
modified function lang/e.sh#build
modified element lang/f.html#app
modified rule lang/g.css#@media (max-width: 800px)..app
modified key lang/h.yml#spring.ldap
modified section lang/i.md#Title.Section A.Sub A1
modified function lang/j.js#plain
modified function lang/k.tsx#App
modified function lang/l.c#helper
modified method lang/m.cpp#app.Svc.save
modified method lang/m.hpp#app.Svc.port
modified field lang/m.hpp#app.Svc.port_
modified method lang/n.cs#App.Svc.Save
modified method lang/o.rs#Runner for Server.run
modified function lang/p.hs#fact
modified key lang/q.json#scripts.build"
actual2="$(node "$SK/scripts/extract.ts" --list --path lang | awk -F'  +' '{ print $1, $2, $3 }')"   # columns are two-space separated; ids may contain spaces
if [ "$actual2" != "$expected2" ]; then
  echo "FAIL: language unit table differs"; echo "--- expected"; echo "$expected2"; echo "--- actual"; echo "$actual2"; exit 1
fi
# back to the base commit: the langs commit (which also took the wip edits) goes, and HEAD must really be base again
git checkout -q -- lang && git reset -q --hard "$BASE_SHA"
[ "$(git rev-parse HEAD)" = "$BASE_SHA" ] && [ ! -d lang ] || { echo "FAIL: teardown of the language fixture left HEAD at $(git rev-parse --short HEAD)"; exit 1; }

# restore the wip change set (Svc.java and parse.ts edited, app.yaml edited, fresh.ts untracked) so the
# round trip below exercises carry-over on real units
cp "$TMP/src-edited/"* "$FX/src/" && cp "$TMP/app.yaml-edited" "$FX/app.yaml"
# fill every slot mechanically with prose that names its own slot ("Fills does src/parse.ts#parseConfig."), so a
# carry-over that attached prose to the wrong unit is visible, not just counted; Changes must name the units
fill() { node -e '
const fs=require("fs"); const B=process.argv[1]; let t=fs.readFileSync(B,"utf8");
t=t.replace(/<<rb:changes [^|]*\| [^\n]*?Must name every unit below: ([^\n]*?)>>/g,(m,names)=>"Touches "+names.split(", ").map(n=>"`"+n+"`").join(", ")+".");
t=t.replace(/<<rb:(\w+) ([^|]*?) \| [^\n]*?>>/g,(m,kind,id)=>"Fills "+kind+" "+id.trim()+".");
t=t.replace(/<<rb:[^\n]*?>>/g,"Overview prose.");
fs.writeFileSync(B,t);' "${1:-$BRIEF}"; }
# every file and unit block must hold the prose written for it: "Fills purpose <path>." under its file marker,
# "Fills does|did|other <id>." under its unit marker
check_attribution() { node -e '
const fs=require("fs"); const t=fs.readFileSync(process.argv[1],"utf8"); const bad=[]; let n=0;
for (const p of t.split("<!-- rb:").slice(1)) {
  const m=p.match(/^(file|unit) (?:path|id)="([^"]+)"/); if(!m) continue; n++;
  const id=m[2], body=p.split("\n---\n")[0], esc=id.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  const ok = m[1]==="file" ? body.includes("Fills purpose "+id+".") : new RegExp("Fills (does|did|other) "+esc+"\\.").test(body);
  if(!ok) bad.push(id);
}
if(bad.length){ console.log("FAIL: prose is not under its own unit after carry-over: "+bad.join(", ")); process.exit(1); }
if(n<2){ console.log("FAIL: no blocks to check"); process.exit(1); }' "${1:-$BRIEF}"; }
# lint_fails CODE WHAT JS — mutate the brief with JS (t is the text), lint must exit 1 and report CODE; the brief is restored
lint_fails() {
  local code="$1" what="$2" js="$3" out rc=0
  cp "$BRIEF" "$TMP/lint-orig.md"
  node -e "const fs=require('fs');const B=process.argv[1];const o=fs.readFileSync(B,'utf8');let t=o;$js;if(t===o){console.error('mutation did not apply: '+process.argv[2]);process.exit(9);}fs.writeFileSync(B,t);" "$BRIEF" "$what"
  out="$(node "$SK/scripts/lint.ts" 2>&1)" || rc=$?
  cp "$TMP/lint-orig.md" "$BRIEF"
  [ "$rc" -eq 1 ] || { echo "FAIL: lint exited $rc, expected 1 — $what"; echo "$out"; exit 1; }
  printf '%s\n' "$out" | grep -q "^$code " || { echo "FAIL: lint did not report $code — $what"; echo "$out"; exit 1; }
}
# skeleton + lint round trip: fill every slot mechanically, lint must pass
out="$(node "$SK/scripts/extract.ts")"
case "$out" in "wrote $BRIEF:"*) ;; *) echo "FAIL: brief not written under the git directory by key: $out"; exit 1 ;; esac
[ -f "$BRIEF" ] && [ ! -f PR_BRIEF.md ] || { echo "FAIL: brief missing or written into the working tree"; exit 1; }
[ -f .git/pr-brief/main/units.json ] && [ "$(cat .git/pr-brief/last)" = main ] || { echo "FAIL: per-key state or the last-key marker missing"; exit 1; }
fill
# a slot value may run on to a second line that merely begins in bold: it is part of the value, not a new label
node -e 'const fs=require("fs");const B=process.argv[1];const t=fs.readFileSync(B,"utf8").replace("Fills does src/parse.ts#parseConfig.","Fills does src/parse.ts#parseConfig.\n**Important:** the second line must survive.");fs.writeFileSync(B,t);' "$BRIEF"
grep -q '^\*\*Important:\*\* the second line' "$BRIEF" || { echo "FAIL: test setup: continuation line not inserted"; exit 1; }
node "$SK/scripts/lint.ts" || { echo "FAIL: lint did not pass on a fully filled brief"; exit 1; }
grep -q '^\*\*Important:\*\* the second line' "$BRIEF" || { echo "FAIL: lint dropped a bold continuation line"; exit 1; }
# lint must fail, with the right code, on each kind of damage (each on a copy; the brief is restored after)
lint_fails EMPTY "an unfilled slot" 't=t.replace(/^\*\*File Context:\*\* [^\n]*$/m,"**File Context:** <<rb:purpose app.yaml | write it>>")'
lint_fails EMPTY "'none' as a review observation" 't=t.replace(/^\*\*Review Observations:\*\* [^\n]*$/m,"**Review Observations:** none")'
lint_fails MISSING "a file Changes that names no unit" 't=t.replace(/^\*\*Changes:\*\* Touches [^\n]*$/m,"**Changes:** Touches nothing by name.")'
lint_fails STYLE "a filler phrase" 't=t.replace(/^\*\*Overview:\*\* [^\n]*$/m,"**Overview:** This function is responsible for stuff.")'
lint_fails STRUCTURE "a unit heading removed" 't=t.replace(/^### [^\n]*\n/m,"")'
lint_fails STRUCTURE "a bullet list after a blank line under Changes" 't=t.replace(/^(\*\*Changes:\*\* Touches [^\n]*\n)\n/m,"$1\n- a stray bullet outside the slot\n\n")'
# a brief saved with CRLF lints clean and is written back with LF
node -e 'const fs=require("fs");const B=process.argv[1];fs.writeFileSync(B,fs.readFileSync(B,"utf8").replace(/\n/g,"\r\n"));' "$BRIEF"
grep -q $'\r' "$BRIEF" || { echo "FAIL: test setup: CRLF conversion did nothing"; exit 1; }
node "$SK/scripts/lint.ts" >/dev/null || { echo "FAIL: lint rejected a CRLF brief"; exit 1; }
grep -q $'\r' "$BRIEF" && { echo "FAIL: lint left CRLF line endings in the brief"; exit 1; }
# a stale state directory (an abandoned run under another key) that claims this brief's path must not be the one
# lint checks against: the brief's own key decides, and among strangers the newest units.json
mkdir -p .git/pr-brief/aaa-stale && node -e '
const fs=require("fs"); const j=JSON.parse(fs.readFileSync(".git/pr-brief/main/units.json","utf8"));
j.expected=["## `nothing.ts` — modified"]; j.generated="2020-01-01T00:00:00.000Z"; fs.writeFileSync(".git/pr-brief/aaa-stale/units.json", JSON.stringify(j));'
node "$SK/scripts/lint.ts" "$BRIEF" >/dev/null || { echo "FAIL: lint checked the brief against a stale state directory that claims its path"; exit 1; }
node -e '
const fs=require("fs"); const j=JSON.parse(fs.readFileSync(".git/pr-brief/main/units.json","utf8")); fs.writeFileSync(".git/pr-brief/aaa-stale/units.json", JSON.stringify({ ...j, key: "aaa-stale", generated: "2020-01-01T00:00:00.000Z", expected: ["## `nothing.ts` — modified"] }));
const b=fs.readFileSync(process.argv[1],"utf8"); fs.writeFileSync(process.argv[1], b.replace(/^key: main$/m, "key: gone"));' "$BRIEF"   # no directory carries the brief's key: the newest claimant wins
node "$SK/scripts/lint.ts" "$BRIEF" >/dev/null || { echo "FAIL: lint preferred an older stale state directory over the newest one"; exit 1; }
sedi 's/^key: gone$/key: main/' "$BRIEF" && rm -rf .git/pr-brief/aaa-stale
# second run must carry everything over — and there must be units to carry, each keeping its own prose
out="$(node "$SK/scripts/extract.ts")"
case "$out" in *"0 slots to fill"*"units carried over)"*) ;; *) echo "FAIL: rerun did not carry over: $out"; exit 1 ;; esac
check_attribution
grep -q '^\*\*Important:\*\* the second line' "$BRIEF" || { echo "FAIL: regeneration dropped a bold continuation line"; exit 1; }
lint_fails LOCKED "carried-over prose edited" 't=t.replace(/^(\*\*Function Context:\*\*) Fills does ([^\n]*)$/m,"$1 Rewritten prose about $2")'
# --fresh starts over: nothing carried, every slot open again; fill and lint so the brief is whole for the checks below
out="$(node "$SK/scripts/extract.ts" --fresh)"
case "$out" in *"carried over"*|*" 0 slots to fill"*) echo "FAIL: --fresh still carried prose over: $out"; exit 1 ;; esac
grep -q 'Fills does' "$BRIEF" && { echo "FAIL: --fresh left old prose in the brief"; exit 1; }
fill
node "$SK/scripts/lint.ts" >/dev/null || { echo "FAIL: lint did not pass after --fresh and a refill"; exit 1; }
out="$(node "$SK/scripts/extract.ts")"
case "$out" in *"0 slots to fill"*"units carried over)"*) ;; *) echo "FAIL: rerun after --fresh did not carry over: $out"; exit 1 ;; esac
# a repository last briefed under the old name and layout (review-brief; REVIEW_BRIEF.md at the root, one shared
# state): state dir, brief file and exclude line are migrated once, the snapshot ref becomes per key, prose intact
mv "$BRIEF" REVIEW_BRIEF.md && sedi '2s/^pr-brief:/review-brief:/' REVIEW_BRIEF.md
mv .git/pr-brief/main/units.json .git/pr-brief/units.json && rm -rf .git/pr-brief/main .git/pr-brief/last && mv .git/pr-brief .git/review-brief
git update-ref refs/review-brief/previous HEAD && git update-ref -d refs/pr-brief/main && printf "REVIEW_BRIEF.md\n" >> .git/info/exclude
out="$(node "$SK/scripts/extract.ts")"
[ -d .git/pr-brief ] && [ ! -d .git/review-brief ] && [ -f "$BRIEF" ] && [ ! -f REVIEW_BRIEF.md ] || { echo "FAIL: old-name state was not migrated"; exit 1; }
[ ! -f .git/pr-brief/units.json ] || { echo "FAIL: shared state from before keys survived"; exit 1; }
grep -qx "REVIEW_BRIEF.md" .git/info/exclude && { echo "FAIL: stale exclude line survived the migration"; exit 1; }
git rev-parse -q --verify refs/pr-brief/main >/dev/null && ! git rev-parse -q --verify refs/review-brief/previous >/dev/null || { echo "FAIL: snapshot ref is not per key"; exit 1; }
case "$out" in *"0 slots to fill"*"units carried over)"*) ;; *) echo "FAIL: migration lost the carry-over: $out"; exit 1 ;; esac
check_attribution
# the previous layout's root file, PR_BRIEF.md, moves the same way
mv "$BRIEF" PR_BRIEF.md && printf "PR_BRIEF.md\n" >> .git/info/exclude
node "$SK/scripts/extract.ts" >/dev/null
[ -f "$BRIEF" ] && [ ! -f PR_BRIEF.md ] || { echo "FAIL: a root PR_BRIEF.md was not moved under its key"; exit 1; }
grep -qx "PR_BRIEF.md" .git/info/exclude && { echo "FAIL: stale PR_BRIEF.md exclude line survived"; exit 1; }
# reviewer notes: one on a unit whose body then changes (kept, marked stale), one on a unit that then
# disappears (orphaned, never dropped), one on a bullet unit (the imports), written where the viewer puts it: after
# the bullet's fence; a since-last hunk containing --> must not break note stripping
node -e '
const fs=require("fs"); const B=process.argv[1]; let t=fs.readFileSync(B,"utf8");
const note=(id,text)=>{ const m=t.indexOf("<!-- rb:unit id=\""+id+"\""); if(m<0) throw new Error("unit missing "+id); const eol=t.indexOf("\n",m); t=t.slice(0,eol+1)+"\n**Notes:** "+text+"\n"+t.slice(eol+1); };
note("src/parse.ts#parseConfig","keep me"); note("src/parse.ts#Loader.size","gone note");
const b=t.indexOf("<!-- rb:unit id=\"src/Svc.java#(imports)\""); if(b<0) throw new Error("imports unit missing"); const fence=t.indexOf("\n```\n",b); t=t.slice(0,fence+5)+"\n**Notes:** NOTE-ON-IMPORTS\n"+t.slice(fence+5);
fs.writeFileSync(B,t);' "$BRIEF"
node "$SK/scripts/lint.ts" >/dev/null || { echo "FAIL: lint rejected a brief with reviewer notes"; exit 1; }
sedi 's/throw new Error("missing")/throw new Error("absent")/; /size(): number/d' src/parse.ts
sedi 's/validate(o);/validate(o); String tag = "<!-- x -->";/' src/Svc.java
node "$SK/scripts/extract.ts" >/dev/null
grep -q '^\*\*Notes:\*\* \*(code changed since this note)\* keep me$' "$BRIEF" || { echo "FAIL: note on an edited unit was dropped or not marked stale"; grep -n 'Notes' "$BRIEF" || true; exit 1; }
grep -q '^## Orphaned notes' "$BRIEF" && grep -q 'gone note' "$BRIEF" || { echo "FAIL: note on a removed unit was not orphaned"; exit 1; }
grep -q '^\*\*Notes:\*\* NOTE-ON-IMPORTS$' "$BRIEF" || { echo "FAIL: a note on a bullet unit did not survive regeneration"; exit 1; }
grep -q '<!-- rb:revise' "$BRIEF" || { echo "FAIL: no revise note for the edited unit"; exit 1; }
fill
node "$SK/scripts/lint.ts" || { echo "FAIL: lint failed with notes and an orphaned-notes section"; exit 1; }
grep -q 'rb:revise' "$BRIEF" && { echo "FAIL: revise notes survived lint"; exit 1; }
grep -q '^-->' "$BRIEF" && { echo "FAIL: a stray --> survived note stripping"; exit 1; }
grep -q 'keep me' "$BRIEF" && grep -q 'NOTE-ON-IMPORTS' "$BRIEF" || { echo "FAIL: note lost by lint"; exit 1; }
lint_fails NOTES "a reviewer note edited" 't=t.replace("keep me","keep me, reworded")'
lint_fails NOTES "a bullet unit's note edited" 't=t.replace("NOTE-ON-IMPORTS","NOTE-ON-IMPORTS-EDITED")'
git -C "$FX" checkout -q -- src app.yaml && rm -f "$FX/src/fresh.ts"

# --- overloads, a renamed method, commit mode ---------------------------------------------
cd "$FX"
cat > src/Over.java <<'EOF2'
public class Over {
    public void save(Order o) { repo.put(o); }
    public void save(Order o, boolean force) { repo.put(o, force); }
    public int legacyCount() {
        int n = repo.count();
        return n;
    }
}
EOF2
git add -A && git commit -qm over
sedi 's/repo.put(o, force);/repo.put(o, force); audit(o);/; s/legacyCount/countAll/' src/Over.java
expected3="modified method src/Over.java#Over.save(Order o, boolean force)
modified method src/Over.java#Over.countAll"
actual3="$(node "$SK/scripts/extract.ts" --list --path src/Over.java | awk -F'  +' '{ print $1, $2, $3 }')"
if [ "$actual3" != "$expected3" ]; then
  echo "FAIL: overload/rename unit table differs"; echo "--- expected"; echo "$expected3"; echo "--- actual"; echo "$actual3"; exit 1
fi
node "$SK/scripts/extract.ts" --path src/Over.java --out "$TMP/over.md" >/dev/null
grep -q 'renamed from `Over.legacyCount`' "$TMP/over.md" || { echo "FAIL: countAll not reported as renamed from legacyCount"; exit 1; }
git add -A && git commit -qm "over edits"
actual4="$(node "$SK/scripts/extract.ts" commit HEAD --list --path src/Over.java | awk -F'  +' '{ print $1, $2, $3 }')"
if [ "$actual4" != "$expected3" ]; then
  echo "FAIL: commit-mode unit table differs from wip"; echo "--- expected"; echo "$expected3"; echo "--- actual"; echo "$actual4"; exit 1
fi
# a commit brief is keyed by the commit's short SHA; one left by the previous layout (commits/<sha>/PR_BRIEF.md) moves under its key
sha="$(git rev-parse --short=7 HEAD)"
mkdir -p ".git/pr-brief/commits/$sha" && printf -- '---\npr-brief: 1\nmode: commit\n---\n# PR Brief — legacy\n' > ".git/pr-brief/commits/$sha/PR_BRIEF.md"
out="$(node "$SK/scripts/extract.ts" commit HEAD --path src/Over.java)"
case "$out" in "wrote $FX/.git/pr-brief/$sha/pr-brief-$sha.md:"*) ;; *) echo "FAIL: commit brief not keyed by its short SHA: $out"; exit 1 ;; esac
[ ! -d .git/pr-brief/commits ] || { echo "FAIL: the legacy commits/ layout survived"; exit 1; }
[ -f ".git/pr-brief/$sha/previous.md" ] || { echo "FAIL: the legacy commit brief was not moved under its key"; exit 1; }
# --key names the brief yourself (one brief standing for a whole stack)
out="$(node "$SK/scripts/extract.ts" --key "my stack/v2" --path src/Over.java)"
case "$out" in "wrote $FX/.git/pr-brief/my-stack-v2/pr-brief-my-stack-v2.md:"*) ;; *) echo "FAIL: --key not sanitised into the brief's name: $out"; exit 1 ;; esac

# --- callers by name: module privacy and same-name declarations -----------------------------
# two scripts each declare and call their own run(); a not-exported run() lists only its own file's call.
# an exported helper called from another file keeps that caller.
mkdir -p src/cli && cat > src/cli/a.ts <<'EOF3'
export function shared(x: number): number { return x + 1; }
function run(): void { console.log(shared(1)); }
run();
EOF3
cat > src/cli/b.ts <<'EOF3'
import { shared } from "./a.ts";
function run(): void { console.log(shared(2)); }
run();
EOF3
git add -A && git commit -qm "cli scripts"
sedi 's/return x + 1;/return x + 2;/; s/console.log(shared(1));/console.log(shared(1) + 1);/' src/cli/a.ts
callers="$(node "$SK/scripts/extract.ts" --list --path src/cli | awk -F'  +' '{ print $3, $6 }')"
case "$callers" in *"src/cli/a.ts#run callers=1"*) ;; *) echo "FAIL: a not-exported run() should list only its own file's call: $callers"; exit 1 ;; esac
case "$callers" in *"src/cli/a.ts#shared callers=2"*) ;; *) echo "FAIL: an exported helper should keep its cross-file caller: $callers"; exit 1 ;; esac
git -C "$FX" checkout -q -- src/cli

# --- file-level changes and awkward inputs -----------------------------------------------------
# a renamed file with a small edit, a deleted file, files without unit rules (whole-file units), a symlink that
# became a regular file (git status T), paths holding a quote and a space, a deleted column-0 `-- ` comment in
# Lua (a diff line starting `--- ` inside a hunk is content, not a file header), and an exported function with a
# doc comment whose callers sit on indented lines of another file
mkdir -p reg && cd "$FX/reg"
cat > old.ts <<'EOF4'
export function one(): number { return 1; }
export function two(): number { return 2; }
export function three(): number { return 3; }
export function four(): number { return 4; }
EOF4
printf 'export function doomed(): number { return 0; }\n' > del.ts
printf 'hello\nworld\n' > notes.txt
cat > m.lua <<'EOF4'
local M = {}
-- helper docs
local function helper(x)
  return x
end
function M.save(o) return o end
return M
EOF4
printf '/** Adds one. */\nexport function shared(x: number): number { return x + 1; }\n' > doc.ts
cat > use.ts <<'EOF4'
import { shared } from "./doc.ts";
export function run(): void {
  shared(2);
  console.log(shared(3));
}
EOF4
cat > more.ts <<'EOF4'
import { shared } from "./doc.ts";
export function a(): number { return shared(1); }
export function b(): number { return shared(2) + shared(3); }
EOF4
printf 'real\n' > real.txt && ln -s real.txt link.txt
printf 'export function q(): number { return 1; }\n' > 'quo"te.ts'
printf 'export function sp(): number { return 1; }\n' > 'sp ace.ts'
cd "$FX" && git add -A && git commit -qm reg
git mv reg/old.ts reg/renamed.ts && sedi 's/return 3;/return 33;/' reg/renamed.ts
git rm -q reg/del.ts
printf 'hello\nthere\n' > reg/notes.txt
printf 'local M = {}\nfunction M.save(o) return o end\nreturn M\n' > reg/m.lua   # the comment and helper are gone
sedi 's/return x + 1;/return x + 2;/' reg/doc.ts
rm reg/link.txt && printf 'now a file\n' > reg/link.txt
sedi 's/return 1;/return 2;/' 'reg/quo"te.ts' 'reg/sp ace.ts'
expected5="deleted function reg/del.ts#doomed - 1-1
modified function reg/doc.ts#shared 1-2 1-2 callers=4
modified file reg/link.txt#(file) - - unsupported-language
modified other reg/m.lua#(top-level)@2 - 2-2
deleted function reg/m.lua#helper - 3-5
modified file reg/notes.txt#(file) - - unsupported-language
modified function reg/quo\"te.ts#q 1-1 1-1
modified function reg/renamed.ts#three 3-3 3-3
modified function reg/sp ace.ts#sp 1-1 1-1"
# status, kind, id, new span, old span, then the sixth column (callers or tag) when it says something
actual5="$(node "$SK/scripts/extract.ts" --list --path reg | awk -F'  +' '{ printf "%s %s %s %s %s", $1, $2, $3, $4, $5; if ($6 != "" && $6 != "callers=0") printf " %s", $6; print "" }')"
if [ "$actual5" != "$expected5" ]; then
  echo "FAIL: file-level unit table differs"; echo "--- expected"; echo "$expected5"; echo "--- actual"; echo "$actual5"; exit 1
fi
node "$SK/scripts/extract.ts" --path reg --out "$TMP/reg.md" >/dev/null
R="$TMP/reg.md"
grep -q '^## \[`reg/renamed.ts`\](reg/renamed.ts) — renamed from `reg/old.ts`$' "$R" || { echo "FAIL: renamed file heading missing"; grep -n '^## ' "$R"; exit 1; }
grep -q '^## `reg/del.ts` — deleted$' "$R" || { echo "FAIL: deleted file heading missing"; grep -n '^## ' "$R"; exit 1; }
grep -q '^\*\*Changes:\*\* <<rb:change reg/del.ts#doomed |' "$R" || { echo "FAIL: a deleted unit has no Changes slot"; exit 1; }
grep -q '^## \[`reg/notes.txt`\](reg/notes.txt) — modified · whole file$' "$R" || { echo "FAIL: whole-file heading missing for .txt"; grep -n '^## ' "$R"; exit 1; }
grep -q 'no unit rules for .txt' "$R" || { echo "FAIL: the whole-file unit does not say why"; exit 1; }
grep -q '^--- helper docs$' "$R" || { echo "FAIL: the deleted Lua comment line is missing from its hunk"; exit 1; }
grep -q '^-real.txt$' "$R" && grep -q '^+now a file$' "$R" || { echo "FAIL: the symlink-to-file change (T) is not shown"; exit 1; }
grep -q '^<!-- rb:file path="reg/quo"te.ts" hash="[0-9a-f]\{16\}" -->$' "$R" || { echo "FAIL: quoted path marker malformed"; grep -n 'rb:file' "$R"; exit 1; }
grep -q '^<!-- rb:file path="reg/sp ace.ts" hash="[0-9a-f]\{16\}" -->$' "$R" || { echo "FAIL: spaced path marker malformed"; grep -n 'rb:file' "$R"; exit 1; }
grep -q 'hash="e3b0c44298fc1c14"' "$R" && { echo "FAIL: a file was hashed as empty content (its path was not read back)"; exit 1; }
# four sites in two files: the count on the label line, then one bullet per file with its lines linked
grep -q '^\*\*Callers (by name):\*\* 4 in 2 files$' "$R" || { echo "FAIL: callers of a documented exported function"; grep -n 'Callers' "$R"; exit 1; }
grep -q '^- \[`reg/more.ts`\](reg/more.ts#L2) \[`2`\](reg/more.ts#L2), \[`3`\](reg/more.ts#L3)$' "$R" || { echo "FAIL: callers bullet for reg/more.ts"; grep -n -A3 'Callers' "$R"; exit 1; }
grep -q '^- \[`reg/use.ts`\](reg/use.ts#L3) \[`3`\](reg/use.ts#L3), \[`4`\](reg/use.ts#L4)$' "$R" || { echo "FAIL: callers bullet for reg/use.ts"; grep -n -A3 'Callers' "$R"; exit 1; }
git reset -q --hard HEAD && git clean -fdq -- reg
[ -L reg/link.txt ] && [ -f reg/old.ts ] && [ ! -f reg/renamed.ts ] || { echo "FAIL: teardown of the reg fixture"; exit 1; }

# --- branch mode: the union of a feature branch's commits against --base, keyed by the branch ---------------------
git checkout -q -b feat
sedi 's/repo.put(o); }/repo.put(o); audit(o); }/' src/Over.java && git commit -qam "feat 1"
sedi 's/console.log(shared(2));/console.log(shared(2) + 2);/' src/cli/b.ts && git commit -qam "feat 2"
expected6="modified method src/Over.java#Over.save(Order o)
modified function src/cli/b.ts#run"
actual6="$(node "$SK/scripts/extract.ts" branch --base main --list | awk -F'  +' '{ print $1, $2, $3 }')"
if [ "$actual6" != "$expected6" ]; then
  echo "FAIL: branch-mode unit table differs"; echo "--- expected"; echo "$expected6"; echo "--- actual"; echo "$actual6"; exit 1
fi
out="$(node "$SK/scripts/extract.ts" branch --base main)"
case "$out" in "wrote $FX/.git/pr-brief/feat/pr-brief-feat.md:"*"2 units"*) ;; *) echo "FAIL: branch brief not keyed by the branch: $out"; exit 1 ;; esac
grep -q '^mode: branch$' .git/pr-brief/feat/pr-brief-feat.md || { echo "FAIL: branch brief does not record its mode"; exit 1; }
git checkout -q main

# --- worktrees: state lives under the common git directory ------------------------------------
# a linked worktree: its .git is a file pointing into the main repository's .git, which is where the brief goes
WT="$TMP/wt" && git worktree add -q -b wt-branch "$WT" HEAD
( cd "$WT" && sedi 's/repo.put(o);/repo.put(o); touched();/' src/Over.java && out="$(node "$SK/scripts/extract.ts")" &&
  case "$out" in "wrote $FX/.git/pr-brief/wt-branch/pr-brief-wt-branch.md:"*) ;; *) echo "FAIL: worktree brief not under the main repository's .git: $out"; exit 1 ;; esac &&
  grep -q "^root: $WT\$" "$FX/.git/pr-brief/wt-branch/pr-brief-wt-branch.md" || { echo "FAIL: worktree brief does not record its worktree"; exit 1; } ) || exit 1
# a bare repository with worktrees beside it: no .git directory anywhere; state goes to .bare/pr-brief/
B="$TMP/bare" && mkdir -p "$B" && git clone -q --bare "$FX" "$B/.bare" && printf 'gitdir: ./.bare\n' > "$B/.git" && git -C "$B" worktree add -q -b bfeat feat HEAD 2>/dev/null
( cd "$B/feat" && sedi 's/repo.put(o);/repo.put(o); touched();/' src/Over.java && out="$(node "$SK/scripts/extract.ts")" &&
  case "$out" in "wrote $B/.bare/pr-brief/bfeat/pr-brief-bfeat.md:"*) ;; *) echo "FAIL: bare-layout brief not under .bare: $out"; exit 1 ;; esac &&
  fill "$B/.bare/pr-brief/bfeat/pr-brief-bfeat.md" && node "$SK/scripts/lint.ts" >/dev/null || { echo "FAIL: lint did not find the brief from a bare-layout worktree"; exit 1; } ) || exit 1
