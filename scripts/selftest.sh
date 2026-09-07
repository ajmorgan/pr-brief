#!/usr/bin/env bash
# selftest.sh — builds a throwaway fixture repo and checks that extract
# produces the expected unit table (spec §16.6). Exit 0 on pass.
set -euo pipefail
# in-place sed on both GNU (Linux) and BSD (macOS) sed
sedi() { if sed --version >/dev/null 2>&1; then sed -i "$@"; else sed -i '' "$@"; fi; }
SK="$(cd "$(dirname "$0")/.." && pwd)"
FX="$(mktemp -d)/fixture"
mkdir -p "$FX/src" && cd "$FX"
git init -q -b main && git config user.email t@t && git config user.name t

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
expected2="modified function lang/a.py#Svc.save
modified function lang/b.kt#Svc.save
new function lang/b.kt#extra
modified method lang/c.go#Server.Start
modified function lang/d.lua#helper
modified function lang/e.sh#build
modified element lang/f.html#app
modified rule lang/g.css#@media (max-width: 800px)..app
modified key lang/h.yml#spring.ldap
modified section lang/i.md#Title.Section A.Sub A1"
actual2="$(node "$SK/scripts/extract.ts" --list --path lang | awk -F'  +' '{ print $1, $2, $3 }')"   # columns are two-space separated; ids may contain spaces
if [ "$actual2" != "$expected2" ]; then
  echo "FAIL: language unit table differs"; echo "--- expected"; echo "$expected2"; echo "--- actual"; echo "$actual2"; exit 1
fi
git -C "$FX" checkout -q -- lang && git -C "$FX" rm -rq lang && git -C "$FX" commit -qm "drop lang" && git -C "$FX" reset -q --hard HEAD~2 2>/dev/null || true

# skeleton + lint round trip: fill every slot mechanically, lint must pass
node "$SK/scripts/extract.ts" >/dev/null
node -e '
const fs=require("fs"); let t=fs.readFileSync("REVIEW_BRIEF.md","utf8");
t=t.replace(/<<rb:changes [^|]*\| [^\n]*?Must name every unit below: ([^\n]*?)>>/g,(m,names)=>"Touches "+names.split(", ").map(n=>"`"+n+"`").join(", ")+".");
t=t.replace(/<<rb:[^\n]*?>>/g,"placeholder text.");
fs.writeFileSync("REVIEW_BRIEF.md",t);'
node "$SK/scripts/lint.ts" || { echo "FAIL: lint did not pass on a fully filled brief"; exit 1; }
# second run must carry everything over
out="$(node "$SK/scripts/extract.ts")"
case "$out" in *"0 slots to fill"*) ;; *) echo "FAIL: rerun did not carry over: $out"; exit 1 ;; esac

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
node "$SK/scripts/extract.ts" --path src/Over.java --out /tmp/rb-selftest-over.md >/dev/null
grep -q 'renamed from `Over.legacyCount`' /tmp/rb-selftest-over.md || { echo "FAIL: countAll not reported as renamed from legacyCount"; exit 1; }
rm -f /tmp/rb-selftest-over.md
git add -A && git commit -qm "over edits"
actual4="$(node "$SK/scripts/extract.ts" commit HEAD --list --path src/Over.java | awk -F'  +' '{ print $1, $2, $3 }')"
if [ "$actual4" != "$expected3" ]; then
  echo "FAIL: commit-mode unit table differs from wip"; echo "--- expected"; echo "$expected3"; echo "--- actual"; echo "$actual4"; exit 1
fi
echo "selftest ok ($FX)"
