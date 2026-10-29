const test = require("node:test");
const assert = require("node:assert/strict");
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
  assert.deepEqual(removed, ["opsdash3:data", "opsdash3:tab"]);
  assert.equal(root.location.replacedWith, "https://lrsbyor.github.io/payroll-private.html");
});

test("storage failure does not prevent redirect into private mode", () => {
  const { root } = fakeRoot(true);
  Object.defineProperty(root, "localStorage", { get() { throw new Error("storage unavailable"); } });
  assert.equal(apply(root), true);
  assert.equal(root.location.replacedWith, "https://lrsbyor.github.io/payroll-private.html");
});

test("redirect failure hides the page instead of falling back to public data", () => {
  const { root } = fakeRoot(true);
  root.location.replace = () => { throw new Error("navigation blocked"); };
  assert.equal(apply(root), true);
  assert.equal(root.document.documentElement.hidden, true);
});
