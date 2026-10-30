const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { apply } = require("../secure-payroll-gate.js");

function fakeRoot(enabled) {
  const removed = [];
  const root = {
    LRS_PRIVATE_PAYROLL_RUNTIME: enabled === undefined ? undefined : { config: { enabled } },
    localStorage: { removeItem: key => removed.push(key) },
    location: { href: "https://lrsbyor.github.io/index.html", replacedWith: null, replace(url) { this.replacedWith = url; } },
    document: { documentElement: { hidden: false } }
  };
  return { root, removed };
}

test("missing or disabled runtime leaves existing dashboard behavior alone", () => {
  for (const enabled of [undefined, false]) {
    const { root, removed } = fakeRoot(enabled);
    assert.equal(apply(root), false);
    assert.deepEqual(removed, []);
    assert.equal(root.location.replacedWith, null);
    assert.equal(root.document.documentElement.hidden, false);
  }
});

test("enabled private mode clears old data caches before redirecting", () => {
  const { root, removed } = fakeRoot(true);
  assert.equal(apply(root), true);
  assert.equal(root.LRS_PRIVATE_PAGE_REDIRECTED, true);
  assert.deepEqual(removed, ["opsdash3:data", "opsdash3:tab"]);
  assert.equal(root.location.replacedWith, "https://lrsbyor.github.io/private-dashboard.html");
});

test("public dashboard aborts its legacy boot code immediately after secure redirect", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const guard = html.indexOf("if(window.LRS_PRIVATE_PAGE_REDIRECTED)");
  const script = html.lastIndexOf("<script>", guard);
  assert.ok(guard >= 0 && script >= 0);
  assert.equal(html.slice(script + "<script>".length, guard).trim(), "");
});

test("storage failure does not prevent redirect into private mode", () => {
  const { root } = fakeRoot(true);
  Object.defineProperty(root, "localStorage", { get() { throw new Error("storage unavailable"); } });
  assert.equal(apply(root), true);
  assert.equal(root.location.replacedWith, "https://lrsbyor.github.io/private-dashboard.html");
});

test("redirect failure hides the page instead of falling back to public data", () => {
  const { root } = fakeRoot(true);
  root.location.replace = () => { throw new Error("navigation blocked"); };
  assert.equal(apply(root), true);
  assert.equal(root.document.documentElement.hidden, true);
});
