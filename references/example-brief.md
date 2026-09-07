---
review-brief: 1
mode: branch
base: f087cbd29c7bfe6ee5ed9d50e201a3ad74639d27
head: f36e06b2f1155c7f2b1a473adcd99f65dddc71fe
snapshot: f36e06b2f1155c7f2b1a473adcd99f65dddc71fe
worktree: clean
generated: 2026-09-06T23:11:35.454Z
previous:
  head: f36e06b2f1155c7f2b1a473adcd99f65dddc71fe
  snapshot: f36e06b2f1155c7f2b1a473adcd99f65dddc71fe
---

# Review Brief — branch (merge-base of origin-main-sim)

> - **Base** `f087cbd` → **Head** `f36e06b` + working tree
> - **Files** 7 changed (2 added, 4 modified, 1 deleted) · **Units** 18 (7 new, 7 modified, 2 deleted, 2 other)
> - **Signature changes** `OrderService.save`
> - **Since last brief** 0 commits — 2 changed, 2 removed, 16 unchanged
> 
> <details class="rb-meta"><summary>Agent instructions</summary>
> 
> **Read these before filling any slot**:
> 
> - `config/app.yaml`
> - `src/orders/OrderService.java`
> - `src/util/callers.ts`
> - `src/util/extra.ts`
> - `src/util/fresh.ts`
> - `src/util/parse.ts`
> 
> **Style:** concise and plain. Declarative sentences; no preamble, hedging, or filler; never restate the heading ("This function…"). Word budgets are ceilings, not targets — most slots need one sentence.
> 
> </details>

**Overview:** Hardens config loading and tightens order persistence. `src/util/parse.ts` carries most of it: `parseConfig` fails fast on a missing file, `normalize` case-folds names, `Loader` gains `size`, `Config` gains an optional `level`, `configPath` exposes the default path, and `DEFAULT_PATH` changes to `app.yml`; `config/app.yaml` moves its `demo` document to level 2 and `src/util/callers.ts` adds a `shutdown` hook. `src/orders/OrderService.java` makes `save` validate before writing and return a boolean, removes the unvalidated `legacySave`, and wires a `clock` for later use. `src/util/fresh.ts` and `src/util/extra.ts` are new placeholder modules with no callers, and `src/util/old.ts` is deleted. Two things a reviewer may want to check: `DEFAULT_PATH` now names `app.yml` while the file is `app.yaml`, and `shutdown` clears a new `Loader` rather than the one `boot` used.

---

## [`config/app.yaml`](config/app.yaml) — modified
<!-- rb:file path="config/app.yaml" hash="038941a6d4f653f2" -->

**Purpose:** Runtime configuration for the demo app: a `name` and a numeric `level`.

**Changes:** Raises `level` from 1 to 2 in the `demo` document; the only change, matching the new optional `level` on `Config` in `src/util/parse.ts`.

### `name: demo` — modified doc · [`config/app.yaml:1-3`](config/app.yaml#L1) · changed since last
<!-- rb:unit id="config/app.yaml#demo" kind="doc" status="modified" hash="038941a6d4f653f2" -->

**Purpose:** The one YAML document: `name: demo` and its `level`.

**Changes:** `level: 1` → `level: 2`.

```diff
 name: demo
-level: 1
+level: 2
```

---

## [`src/orders/OrderService.java`](src/orders/OrderService.java) — modified
<!-- rb:file path="src/orders/OrderService.java" hash="cca5f755dd85d2ce" -->

**Purpose:** Persists and retrieves orders through a `Repo`. It is the single write path for orders.

**Changes:** Adds validation before persisting and removes the unvalidated path. `save` now calls a new private `validate` and returns a boolean; `legacySave` is deleted. The `OrderService` constructor also initialises a new `clock` field, which nothing reads yet.

**Other changes:**
<!-- rb:unit id="src/orders/OrderService.java#(imports)" kind="other" status="modified" hash="913dd4a15b2d4fb8" -->
- [`OrderService.java:4-4`](src/orders/OrderService.java#L4) (imports) — Imports `java.util.Objects` for the null check in `validate`.
```diff
@@ -3,0 +4 @@
 package orders;
 
 import java.util.List;
+import java.util.Objects;
 
 public class OrderService {
     private final Repo repo;
     private final Clock clock;
 
     public OrderService(Repo repo) {
```

### `Clock clock` — new field · [`src/orders/OrderService.java:8-8`](src/orders/OrderService.java#L8)
<!-- rb:unit id="src/orders/OrderService.java#OrderService.clock" kind="field" status="new" hash="302e9d5c6a79ca88" -->

**Purpose:** Holds a `Clock`, set to system UTC in the constructor; no method reads it yet.

```diff
+    private final Clock clock;
```

### `OrderService(Repo repo)` — modified constructor · [`src/orders/OrderService.java:10-13`](src/orders/OrderService.java#L10)
<!-- rb:unit id="src/orders/OrderService.java#OrderService.OrderService" kind="constructor" status="modified" hash="1986b8243728f5ac" -->

**Callers (by name):** none found

**Purpose:** Stores the given `Repo` and initialises `clock` to `Clock.systemUTC()`.

**Changes:** Additionally assigns `this.clock = Clock.systemUTC()`. Nothing else changed.

```diff
     public OrderService(Repo repo) {
         this.repo = repo;
+        this.clock = Clock.systemUTC();
     }
```

**Notes:** callers must handle the boolean now

### `boolean save(Order o)` — modified · [`src/orders/OrderService.java:15-19`](src/orders/OrderService.java#L15)
<!-- rb:unit id="src/orders/OrderService.java#OrderService.save" kind="method" status="modified" hash="89af824f51aa52cf" -->

**Callers (by name):** none found

**Purpose:** Validates the order, writes it to the repo under its id, and returns `true`.

**Changes:** Signature changed from `public void save(Order o)` to `public boolean save(Order o)`. Now calls `validate(o)` before `repo.put` and returns the constant `true`; previously it only did the put. Meant to reject orders with a null id before they reach storage.

```diff
-    public void save(Order o) {
+    public boolean save(Order o) {
+        validate(o);
         repo.put(o.id(), o);
+        return true;
     }
```

### `void legacySave(Order o)` — deleted · was `src/orders/OrderService.java:20-22`
<!-- rb:unit id="src/orders/OrderService.java#OrderService.legacySave" kind="method" status="deleted" hash="2eec558539c86c80" -->

**Callers (by name):** none found

**Purpose:** Wrote an order through `repo.putLegacy` with no validation. No direct replacement; `save` is the remaining write path.

```diff
-    public void legacySave(Order o) {
-        repo.putLegacy(o);
-    }
```

### `void validate(Order o)` — new · [`src/orders/OrderService.java:25-27`](src/orders/OrderService.java#L25)
<!-- rb:unit id="src/orders/OrderService.java#OrderService.validate" kind="method" status="new" hash="282077289500bc75" -->

**Purpose:** Throws `NullPointerException` with message `"id"` when the order's id is null; otherwise returns normally.

```diff
+    private void validate(Order o) {
+        Objects.requireNonNull(o.id(), "id");
+    }
```

---

## [`src/util/callers.ts`](src/util/callers.ts) — modified
<!-- rb:file path="src/util/callers.ts" hash="a4828e29286d24e5" -->

**Purpose:** Entry points that drive the config loader: `boot` warms it and `shutdown` clears it.

**Changes:** Adds a `shutdown` function so a loader cache can be cleared at exit. Note it clears a newly constructed `Loader`, not the instance `boot` created.

### `shutdown()` — new · [`src/util/callers.ts:9-11`](src/util/callers.ts#L9)
<!-- rb:unit id="src/util/callers.ts#shutdown" kind="function" status="new" hash="f29ff52441265a4b" -->

**Purpose:** Constructs a new `Loader` and calls `clear()` on it. Because the instance is fresh, its cache is already empty; the loader used by `boot` is untouched.

```diff
+export function shutdown(): void {
+  new Loader().clear();
+}
```

---

## [`src/util/extra.ts`](src/util/extra.ts) — added
<!-- rb:file path="src/util/extra.ts" hash="2a0472552d30dbbd" -->

**Purpose:** New module exporting one boolean helper; no callers yet.

### `extra()` — new · [`src/util/extra.ts:1-3`](src/util/extra.ts#L1)
<!-- rb:unit id="src/util/extra.ts#extra" kind="function" status="new" hash="8e8d3825cb8715d8" -->

**Purpose:** Returns `true`.

```diff
+export function extra(): boolean {
+  return true;
+}
```

---

## [`src/util/fresh.ts`](src/util/fresh.ts) — added
<!-- rb:file path="src/util/fresh.ts" hash="b771b16d98ce8e54" -->

**Purpose:** New module exporting one string helper; no callers yet.

### `fresh()` — new · [`src/util/fresh.ts:1-3`](src/util/fresh.ts#L1)
<!-- rb:unit id="src/util/fresh.ts#fresh" kind="function" status="new" hash="fc55ea4a2577fe81" -->

**Purpose:** Returns the string `"new"`.

```diff
+export function fresh(): string {
+  return "new";
+}
```

---

## `src/util/old.ts` — deleted
<!-- rb:file path="src/util/old.ts" hash="48ad7623fc738ddc" -->

**Purpose:** Held the obsolete `gone` helper. The file was deleted.

**Changes:** Removes the module and its only export, `gone`. No callers existed.

### `gone()` — deleted · was `src/util/old.ts:1-3`
<!-- rb:unit id="src/util/old.ts#gone" kind="function" status="deleted" hash="119aff784e9ace24" -->

**Callers (by name):** none found

**Purpose:** Returned the constant `1`. No replacement.

```diff
-export function gone(): number {
-  return 1;
-}
```

---

## [`src/util/parse.ts`](src/util/parse.ts) — modified
<!-- rb:file path="src/util/parse.ts" hash="140444b3c2092f79" -->

**Purpose:** Reads and normalises the app config file, caches parsed configs per path via `Loader`, and defines the `Config` shape.

**Changes:** Hardens loading and exposes more of the loader. `parseConfig` fails fast with a clear error when the file is missing; `normalize` lower-cases the name; `Loader` gains a `size` method; `Config` gains an optional `level`; a new `configPath` returns the default path; `DEFAULT_PATH` is renamed to `app.yml`, and the `fs` import gains `existsSync`.

**Other changes:**
<!-- rb:unit id="src/util/parse.ts#(imports)" kind="other" status="modified" hash="2bd887450024cf9f" -->
- [`parse.ts:1-1`](src/util/parse.ts#L1) (imports) — Also imports `existsSync` from `fs`.
```diff
@@ -1 +1 @@
-import { readFileSync } from "fs";
+import { readFileSync, existsSync } from "fs";
 
 export const DEFAULT_PATH = "config/app.yml";
 
 export function parseConfig(path: string): Config {
   if (!existsSync(path)) throw new Error(`config not found: ${path}`);
   const raw = readFileSync(path, "utf-8");
```

### `DEFAULT_PATH` — modified const · [`src/util/parse.ts:3-3`](src/util/parse.ts#L3) · changed since last
<!-- rb:unit id="src/util/parse.ts#DEFAULT_PATH" kind="const" status="modified" hash="746fb8cc3ce0048b" -->

**Purpose:** The default config location, `config/app.yml`.

**Changes:** Value changed from `config/app.yaml` to `config/app.yml`; the file in the repo is still `app.yaml`.

```diff
-export const DEFAULT_PATH = "config/app.yaml";
+export const DEFAULT_PATH = "config/app.yml";
```

### `parseConfig(path: string)` — modified · [`src/util/parse.ts:5-9`](src/util/parse.ts#L5)
<!-- rb:unit id="src/util/parse.ts#parseConfig" kind="function" status="modified" hash="174e134be7e40ff9" -->

**Callers (by name):** [`src/util/callers.ts:6`](src/util/callers.ts#L6), [`src/util/parse.ts:21`](src/util/parse.ts#L21) (2)

**Purpose:** Reads the file at `path` and JSON-parses it into a `Config`. Called by `Loader.load` and directly by `boot`.

**Changes:** Now throws `Error("config not found: <path>")` when the file does not exist, before reading. Previously `readFileSync` would throw its own ENOENT error.

```diff
 export function parseConfig(path: string): Config {
+  if (!existsSync(path)) throw new Error(`config not found: ${path}`);
   const raw = readFileSync(path, "utf-8");
   return JSON.parse(raw);
 }
```

### `normalize = (c: Config): Config` — modified arrow · [`src/util/parse.ts:11-13`](src/util/parse.ts#L11)
<!-- rb:unit id="src/util/parse.ts#normalize" kind="arrow" status="modified" hash="bb7a9d4148bec11e" -->

**Callers (by name):** [`src/util/parse.ts:21`](src/util/parse.ts#L21) (1)

**Purpose:** Returns a copy of the config with `name` trimmed and lower-cased. Used by `Loader.load`.

**Changes:** Appends `.toLowerCase()` after `.trim()`, so names are now case-folded as well as trimmed.

```diff
 export const normalize = (c: Config): Config => {
-  return { ...c, name: c.name.trim() };
+  return { ...c, name: c.name.trim().toLowerCase() };
 };
```

### `size(): number` — new · [`src/util/parse.ts:26-28`](src/util/parse.ts#L26)
<!-- rb:unit id="src/util/parse.ts#Loader.size" kind="method" status="new" hash="6532bc77953bea51" -->

**Purpose:** Returns the number of entries in the cache.

```diff
+  size(): number {
+    return this.cache.size;
+  }
```

### `interface Config` — modified interface · [`src/util/parse.ts:35-38`](src/util/parse.ts#L35)
<!-- rb:unit id="src/util/parse.ts#Config" kind="interface" status="modified" hash="d7ee5f39282a6081" -->

**References (by name):** none found

**Purpose:** Shape of a parsed config: required `name`, optional numeric `level`.

**Changes:** Adds an optional `level?: number` field.

```diff
 export interface Config {
   name: string;
+  level?: number;
 }
```

### `configPath()` — new · [`src/util/parse.ts:40-42`](src/util/parse.ts#L40)
<!-- rb:unit id="src/util/parse.ts#configPath" kind="function" status="new" hash="f96f603d3518a269" -->

**Purpose:** Returns `DEFAULT_PATH`.

```diff
+export function configPath(): string {
+  return DEFAULT_PATH;
+}
```
