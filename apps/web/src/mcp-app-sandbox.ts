/**
 * The MCP Apps sandbox proxy (ADR-0079), as the `srcdoc` of an `<iframe sandbox="allow-scripts">`:
 * an opaque origin, so nothing in it is the Sessionboxer origin. It tells the host it is ready,
 * takes the view's HTML with the CSP to apply, puts the CSP `<meta>` ahead of the HTML in an inner
 * `srcdoc` iframe (opaque too), and relays every other message between host and view — host
 * messages are the parent's (`event.source === window.parent`), view messages the inner frame's.
 * Origins are `null` on both sides, so sources, not origins, are what is checked.
 */
import type { McpUiCsp } from "@sessionboxer/protocol";

/** The spec's CSP construction (apps.mdx, "Content Security Policy"), with the domains a view may use. */
export function viewCsp(csp: Partial<McpUiCsp> | null): string {
  const list = (d: string[] | undefined) => (d && d.length > 0 ? ` ${d.join(" ")}` : "");
  const resources = list(csp?.resourceDomains);
  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline'${resources}`,
    `style-src 'self' 'unsafe-inline'${resources}`,
    `connect-src 'self'${list(csp?.connectDomains)}`,
    `img-src 'self' data:${resources}`,
    `font-src 'self'${resources}`,
    `media-src 'self' data:${resources}`,
    `frame-src${csp?.frameDomains && csp.frameDomains.length > 0 ? ` ${csp.frameDomains.join(" ")}` : " 'none'"}`,
    "object-src 'none'",
    `base-uri${csp?.baseUriDomains && csp.baseUriDomains.length > 0 ? ` ${csp.baseUriDomains.join(" ")}` : " 'self'"}`,
  ].join("; ");
}

export const SANDBOX_PROXY_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}iframe{display:block;width:100%;height:100%;border:0}</style>
</head>
<body>
<script>
(function () {
  "use strict";
  if (window.self === window.top) return;
  var RESOURCE_READY = "ui/notifications/sandbox-resource-ready";
  var PROXY_READY = "ui/notifications/sandbox-proxy-ready";
  var inner = null;
  var queue = [];
  function attr(v) { return String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;"); }
  function mount(params) {
    if (inner) inner.remove();
    inner = document.createElement("iframe");
    inner.setAttribute("sandbox", typeof params.sandbox === "string" ? params.sandbox : "allow-scripts allow-forms");
    if (typeof params.allow === "string" && params.allow) inner.setAttribute("allow", params.allow);
    var meta = '<meta http-equiv="Content-Security-Policy" content="' + attr(params.cspPolicy || "default-src 'none'") + '">';
    inner.srcdoc = meta + String(params.html || "");
    document.body.appendChild(inner);
    inner.addEventListener("load", function () {
      var q = queue; queue = [];
      for (var i = 0; i < q.length; i++) inner.contentWindow.postMessage(q[i], "*");
    });
  }
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (event.source === window.parent) {
      if (data && data.method === RESOURCE_READY) { mount(data.params || {}); return; }
      if (inner && inner.contentWindow) inner.contentWindow.postMessage(data, "*");
      else queue.push(data);
    } else if (inner && event.source === inner.contentWindow) {
      window.parent.postMessage(data, "*");
    }
  });
  window.parent.postMessage({ jsonrpc: "2.0", method: PROXY_READY, params: {} }, "*");
})();
</script>
</body>
</html>
`;
