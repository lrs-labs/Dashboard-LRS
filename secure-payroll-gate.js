(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LRSPrivatePayrollGate = api;
  if (root?.document) api.apply(root);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function apply(root) {
    if (root?.LRS_PRIVATE_PAYROLL_RUNTIME?.config?.enabled !== true) return false;
    try {
      root.localStorage?.removeItem("opsdash3:data");
      root.localStorage?.removeItem("opsdash3:tab");
    } catch (_) {
      // A storage policy error cannot stop the secure-mode redirect.
    }
    try {
      root.location.replace(new URL("./payroll-private.html", root.location.href).href);
    } catch (_) {
      // Keep the current page hidden rather than fall back to public data.
      if (root.document?.documentElement) root.document.documentElement.hidden = true;
    }
    return true;
  }

  return { apply };
});
