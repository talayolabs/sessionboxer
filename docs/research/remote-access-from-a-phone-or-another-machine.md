# Research: reaching Sessionboxer from a phone or another machine

Question (2026-09-19): run Sessionboxer on a server (a Raspberry Pi at home, a Hetzner VPS, a machine in the
house) with the boxes there, and use it from another computer on a different network — including a phone.
The home case has no public IP, so "maybe we need a central public server both sides register with so they
find each other (a tunnel? directly? …)".

Short answer: that central server already exists as a product — three times over — and none of them needs a
line of code from us: **Tailscale** (its coordination server is the rendezvous, WireGuard between the devices,
its DERP relays when NAT is too tight; `tailscale serve` gives an HTTPS URL for the tailnet), **Cloudflare
Tunnel** (the home server dials out to Cloudflare's edge, the phone opens a normal `https://` URL on your
domain, Cloudflare Access puts a login in front), or, when the server *is* a VPS with a public IP, plain
**Caddy** on it. Building our own relay is possible but a 2–3 session detour that reproduces Tailscale badly;
not now. What *does* need to change in Sessionboxer, whatever the transport: it has **no authentication at
all** today (anyone reaching port 4000 has your Claude token's agent, root in every box, your GitHub login),
the WebSockets have no keepalive (Cloudflare cuts an idle one at 100 s), it assumes its origin is
`http://127.0.0.1:4000` in two places, and the layout needs a 390 px-wide phone mode with a touch desktop.
Plan: **stage 1** access token + devices + pairing QR + keepalives + the three guides (~1 session, no image
rebuild); **stage 2** phone layout (~1 session); **stage 3** push notifications to a sleeping phone (~½–1).

## 1. What is on the wire today, and what breaks off-localhost

| Piece | Where | Remote consequence |
| --- | --- | --- |
| Bind address `SESSIONBOXER_HOST` (default `127.0.0.1`), `SESSIONBOXER_PORT` 4000 | `apps/control-plane/src/config.ts` | Already configurable; the recommended setups below keep `127.0.0.1` and put a proxy on the same host in front, so this is not the problem. |
| **No auth on `/api/*`**: sessions, terminals (a root shell in the box), desktop, Code, settings (tokens write-only, but *usable*), uploads | `apps/control-plane/src/index.ts` | The whole feature hinges on adding it. Everything sensitive (Claude/Devin tokens, GitHub logins, MCP secrets) is reachable through the API without ever being read. |
| Six WebSocket kinds: `/api/ws` (UI pushes), terminals, desktop (RFB), Code (VS Code), all plain upgrades with no ping/pong | `index.ts`, `terminal-bridge.ts`, `desktop-proxy.ts`, `code-proxy.ts` | Cloudflare (Free/Pro) closes a WebSocket idle for 100 s; nginx/Caddy defaults 60 s; cellular NATs 30–120 s. `/api/ws` reconnects after 1 s (`api.ts`), the desktop and terminals do not. An idle chat tab on a phone would go stale silently. |
| Origin assumptions: OAuth callback `http://${HOST}:${PORT}/api/connectors/github/callback` (`index.ts:72`), README/Settings text quoting it | `index.ts`, `App.tsx:1644` | The **`gh` device login** (the default) has no callback and works from anywhere; only the OAuth-App redirect flow needs a `SESSIONBOXER_PUBLIC_URL`. |
| Browser APIs that need a **secure context** (HTTPS or `localhost`): `navigator.clipboard` (copy message, desktop clipboard, LLM dialog copy), `Notification` (PR feedback toasts), **service workers → VS Code webviews** (Markdown preview, extension webviews in the Code pane) | `CopyMessage.tsx`, `Desktop.tsx`, `PullRequests.tsx`, openvscode-server | Plain `http://server-ip:4000` from another machine loses all of these; openvscode says so itself (gitpod-io/openvscode-server#268). **HTTPS is therefore not optional**, which is also why every option below terminates TLS. |
| Layout: `.app { grid-template-columns: 290px 1fr }`, `.chat { min-width: 360px }` + `.desktop { flex: 0 0 50% }` side by side, `.session-header` with ~12 buttons, one `@media (max-width: 900px)` rule (compaction dialog only) | `apps/web/src/styles.css` | Unusable under ~800 px: sidebar eats the phone, chat and desktop fight for 360 + 50 %. §5. |
| noVNC `RFB` with `scaleViewport = true` | `Desktop.tsx` | Touch already works: noVNC's gesture handler maps tap → left click, two-finger tap → right, three-finger tap → middle, long press → right, drag → left-drag, two-finger drag → scroll (`core/rfb.js` `_handleGesture`). Missing: a way to open the phone's keyboard (the core has no hidden input; `vnc.html` adds one). |
| CLI `SESSIONBOXER_URL` | `apps/cli/src/index.ts` | Needs a `SESSIONBOXER_TOKEN` (or reads the local config) once auth exists. |
| Image builds on arm64 (`dpkg --print-architecture` switch in the Dockerfile, README "builds natively on Apple Silicon") | `images/sandbox/Dockerfile` | A Raspberry Pi 4/5 or a Hetzner CAX (Ampere) can build and run boxes. I believe Sysbox ships arm64 packages too; not verified here — *Docker inside the Sandbox* would fall back to privileged mode otherwise. |

Nothing inside the Sandbox is affected: the Daemon, noVNC and openvscode-server are only ever reached by the
Control Plane over the private Docker network (ADR-0005), and the browser talks to the Control Plane alone.

## 2. The "central server" question: how a phone reaches a box behind a home NAT

Both ends (home server behind the ISP router, phone on LTE) can open outbound connections but accept none, so a
third party with a public address is needed for at least the introduction. The choices differ in *who runs it*
and *what the phone needs*:

| | Rendezvous | On the phone | URL you get | Who logs the user in | Cost | Our code |
| --- | --- | --- | --- | --- | --- | --- |
| **Tailscale Serve** | Tailscale's coordination server; traffic is WireGuard **device-to-device** (direct after NAT traversal, via a DERP relay otherwise; relays cannot decrypt) | Tailscale app (iOS/Android/desktop), logged into the same account | `https://<server>.<tailnet>.ts.net` with a real Let's Encrypt certificate, tailnet-only | The tailnet: only your devices can even connect; `Tailscale-User-Login` header identifies who | Free "Personal" plan: up to 6 users, unlimited devices | None to be reachable; app auth still wanted (§3) |
| **Tailscale Funnel** | same, plus Tailscale's Funnel relays for anyone on the internet | Nothing | same `ts.net` URL, public | **Nobody** — that is our access token's job | Free (beta) | App auth mandatory |
| **Headscale** | The same protocol with the coordination server **self-hosted on your VPS** (open source) | Tailscale app pointed at your server | as Serve, with your own DNS/certs | you | VPS only | None |
| **Cloudflare Tunnel + Access** | Cloudflare's edge: `cloudflared` on the home server keeps outbound connections open, Cloudflare terminates TLS on your domain and forwards over the tunnel | Nothing — a browser | `https://box.yourdomain.tld` | **Cloudflare Access** in front (email one-time code, Google/GitHub login, up to 50 users free); app auth behind it as second layer | Free plan; needs a domain on Cloudflare (~$10/yr) | Keepalives (100 s idle cut); trust `Cf-Access-Authenticated-User-Email` optionally |
| **VPS with a public IP** (Hetzner CX/CAX: the server *is* the box host) | none needed | Nothing | `https://box.yourdomain.tld` via Caddy with automatic certificates | our access token (+ Caddy `basic_auth` or a client cert if you like) | VPS €4–15/mo | App auth mandatory |
| **Home server + VPS as your own relay** | your VPS: WireGuard (or `ssh -R`) from home to VPS, Caddy on the VPS proxies to the tunnel's address | Nothing | as above | our access token | VPS + your time | App auth mandatory |
| **Our own relay service** ("Sessionboxer Connect": Control Plane dials out to a public relay we run or you deploy; browsers hit `https://<id>.relay/`, relay multiplexes HTTP+WS back over one connection) | ours | Nothing | relay subdomain | ours (token/OIDC) | hosting + on-call | ~2–3 sessions: yamux-style multiplexer, TLS, per-tenant routing, abuse controls, HA. Reproduces Cloudflare Tunnel/Funnel with fewer PoPs. |
| WebRTC data channel browser ↔ Control Plane with a small signaling server | ours (signaling only, TURN for hard NATs) | Nothing | — | ours | TURN bandwidth | Whole UI transport (fetch, 6 WS kinds, VS Code iframe) would have to be tunnelled over a data channel: rewrite of `api.ts` + a service worker. Rejected. |

Reading this against the question: yes, a public rendezvous is required for the home case; no, we should not
write it. Tailscale *is* "both reach a central server and then talk directly" (with relays as fallback);
Cloudflare Tunnel is "the central server carries the traffic" without anything installed on the phone.

**Recommendation.** Just you, on your own devices → **Tailscale Serve** (ten minutes, no domain, phone app,
URL works from any network, the tailnet ACL is a hard wall in front of our auth). A URL that works from any
browser, or sharing with someone → **Cloudflare Tunnel + Access** on a domain you own. If the machine is a
VPS → **Caddy** on it (Tailscale still fine, and hides the port entirely). Whatever you pick, stage 1 below
ships, because Funnel/VPS have no gate but ours, and defence in depth for the other two costs nothing.

Where the boxes should live: a Hetzner CAX21 (4 vCPU arm64, 8 GB, ~€7/mo) or CX32 (x86, 8 GB) runs 2–3 boxes
comfortably (rough figure: an idle box with the desktop, Daemon and agent is well under 1 GB RAM; a Claude
turn compiling something wants a core);
a Raspberry Pi 5 8 GB does one or two, with the image build taking ~20–30 min there (build on a faster arm64
machine and `docker save | ssh pi docker load`, or let the Pi do it overnight). Snapshots are full `docker
commit`s (ADR-0009), so give the Docker data-root an SSD, not the SD card.

## 3. Stage 1: authentication, devices, keepalives, origin (no Sandbox change)

**Access token.** First start without one generates 32 random bytes (base64url) into `config.json` as
`accessToken`; `SESSIONBOXER_ACCESS_TOKEN` in the environment overrides. `npm start` / `sessionboxer serve`
print `open http://127.0.0.1:4000/#token=…` once (the same URL the CLI's `--open` uses). **Settings →
Remote access** shows it (reveal / copy / regenerate — regenerating logs every device out).

**How a browser logs in.** `POST /api/auth/login {token}` → the Control Plane compares in constant time,
creates a **device** row (`id, name from User-Agent, created_at, last_seen_at, last_ip`) and sets a cookie
`sb_session=<random 32 bytes>; HttpOnly; SameSite=Strict; Path=/; Max-Age=1y`, `Secure` when the request came
over TLS (`X-Forwarded-Proto: https` from Caddy/cloudflared/tailscale, or a TLS listener). The web app calls
it from the `#token=` fragment (removed from the URL right after) or from a **login page** shown on any 401:
a single field "access token". Cookies cover everything the browser fetches from the same origin, which is
the reason to prefer them over a bearer header: `<img>`/`<video>` of `/fs/raw` media, the VS Code iframe under
`/api/sessions/:id/code/*`, downloads, and all six WebSocket kinds (browsers cannot set headers on a
WebSocket upgrade). The CLI and scripts use `Authorization: Bearer <token>` instead; both are accepted.

**Pairing a phone without typing 43 characters.** Settings → Remote access → **Add a device**: the Control
Plane mints a one-time code (5 minutes, single use), the page shows a QR of `https://<origin>/#pair=<code>`
(the origin the *current* browser used, so it works for Tailscale, Cloudflare or VPS URLs alike) and the
same link as text. Scanning it logs the phone in and lists it under **Devices** with revoke buttons and
"revoke all others". QR generation is a small dependency (`qrcode`) in the web app only.

**Enforcement.** A Hono middleware in front of `/api/*` (health excepted): a valid cookie or bearer, else
`401 {error: "login required"}` and, for WebSocket upgrades, refusing the upgrade. Login attempts are
rate-limited per IP (5 failures → 1 minute back-off) and logged. Mutating requests and upgrades also check
`Origin`/`Sec-Fetch-Site` against the request's own host to block cross-site use of the cookie (belt to
`SameSite=Strict`'s braces). Loopback gets **no exemption**: `tailscale serve` and `cloudflared` both connect
from 127.0.0.1, so "trust localhost" would silently open the exact deployment this is for. The old behaviour
remains as `SESSIONBOXER_AUTH=off` for a machine that is truly only yours, with a red banner in the UI.

**Optional identity from the proxy.** `SESSIONBOXER_TRUST_PROXY_AUTH=tailscale|cloudflare` accepts
`Tailscale-User-Login` / `Cf-Access-Authenticated-User-Email` as a login *instead of* the token (auto-creates
the device, names it after the user). Off by default and only sensible when the Control Plane listens on
loopback behind that proxy (both vendors say so themselves), since anyone else who can reach the port could
forge the header. Nice for Tailscale where the tailnet already proved who you are; it makes the phone
pairing step disappear.

**Keepalives and reconnects.** The Control Plane pings every WebSocket it owns every 25 s (protocol-level
ping frames, `ws` supports them; for the proxied desktop and Code sockets it pings the *browser* side and
lets the box side be) and drops a socket that misses two pongs; the browser side reconnects the desktop
(`RFB` recreate) and terminals (reattach to the same pty id — the Daemon keeps ptys across a socket drop
today) with the same 1 s back-off `/api/ws` uses. 25 s clears Cloudflare's 100 s, Caddy's/nginx's 60 s and
mobile NATs.

**Origin awareness.** `SESSIONBOXER_PUBLIC_URL` (else derived from `X-Forwarded-Proto`/`Host` of the request)
replaces the two hard-coded `http://127.0.0.1:4000` for the OAuth-App callback and the Settings hint; the
`gh` device flow, the default, has nothing to change. The CLI gets `SESSIONBOXER_TOKEN` and, when unset and
`SESSIONBOXER_URL` is the local default, reads `accessToken` from `~/.sessionboxer/config.json`.

**Guides** (README "Remote access", each ten lines, all keeping `SESSIONBOXER_HOST=127.0.0.1`):

- *Tailscale*: install on server and phone, `tailscale serve --bg 4000`, open the printed `https://….ts.net`,
  paste the token or scan the QR from a logged-in browser; `tailscale funnel 4000` only if a public URL is
  really wanted. Optional `SESSIONBOXER_TRUST_PROXY_AUTH=tailscale`.
- *Cloudflare Tunnel*: `cloudflared tunnel create`, public hostname → `http://127.0.0.1:4000`, an Access
  application on that hostname with your email; note the 100 s idle cut is handled by keepalives.
- *VPS / Caddy*: `box.example.org { reverse_proxy 127.0.0.1:4000 }`; Caddy handles certificates and
  WebSockets by default; `read_timeout`/`write_timeout` not needed once the keepalives exist. Docker + (on
  Linux x86) Sysbox on the VPS as on a laptop; arm64 note for Pi/CAX.

Effort ~1 session: DB migration (`devices`), middleware, login page + Settings section + QR, keepalives on
six socket paths, README. No protocol change reaches the Daemon; no image rebuild.

## 4. What stays true about secrets after this

Nothing new is exposed: `PublicSettings` keeps tokens write-only; the access token is the only value shown
(and only after clicking reveal), device cookies are random ids stored hashed (SHA-256) in SQLite so a copy
of `db.sqlite` cannot be replayed; the one-time pairing codes live in memory. Boxes are unchanged: still no
published ports (ADR-0005), still reached only by the Control Plane.

## 5. Stage 2: the phone layout

One breakpoint at 800 px switches to a **single-pane app**:

- The **sidebar becomes a drawer** (hamburger in a slim top bar with the session title and status dot; swipe
  from the left edge also opens it). New session / Settings live in the drawer as today.
- **Chat becomes a pane** like the others: a **bottom tab bar** `Chat · Desktop · Code · Terminal · Context ·
  PRs` (badges for PR activity as in the header today) replaces the header's segmented control; the rest of
  the header (Snapshot, Fork, MCP, Instructions, Resume, Delete, Inspect LLM, branch selector) collapses into
  a `⋯` sheet.
- **Composer**: sticky at the bottom, `height: 100dvh` for the app and a `visualViewport` listener so the
  soft keyboard pushes it up instead of hiding it (the classic iOS Safari problem); the toolbar collapses to
  attach + send with the formatting bar behind a button; zen mode is the natural full-screen editor on a
  phone. Bubbles already cap at 900 px and wrap, tool groups already collapse; the `LLM #n` tabs stay.
- **Desktop**: noVNC already scales to fit (`scaleViewport`) and translates touch gestures (§1). Add a
  **keyboard button** that focuses a hidden `<input>` whose key events go to `rfb.sendKey`, a **Ctrl / Alt /
  Esc / Tab** row while it is open, and a pinch-to-zoom toggle (`clipViewport + dragViewport` for a 1:1 view
  that pans; `scaleViewport` for the overview). Landscape hint for a 1280×800 desktop on a 390 px screen.
- **Code**: the VS Code iframe works on a phone once HTTPS is there; it is what it is on a small screen.
  **Terminal**: xterm.js handles touch scrolling; the fit addon recalculates on rotation.
- **PWA**: a `manifest.webmanifest` (name, icon, `display: standalone`, dark theme colour) so "Add to Home
  Screen" gives an app-like window with no address bar; it is also the prerequisite for push on iOS (§6).

~1 session, CSS + a few components; nothing server-side.

## 6. Stage 3: being told while the phone is in your pocket

Today's PR notification uses `new Notification()` from an open tab. A phone that switched apps has no open
tab, so **Web Push** is the real thing: a service worker in the web app, a VAPID key pair generated by the
Control Plane on first use, `PushSubscription`s stored per device, and the Control Plane calling the push
service (Apple's/Google's/Mozilla's — the Control Plane needs outbound internet, which it has) via
`web-push` on: turn ended, agent asked a question, PR feedback arrived, Session errored, per-device toggles.
Tapping the notification deep-links to `#/s/<id>`. I believe iOS requires the site to be installed to the
Home Screen for push (16.4+); Android/desktop Chrome and Firefox do not. ~½–1 session.

## 7. Decisions

1. **Which transport do you want the first guide and test for?** Tailscale Serve (I would start there —
   needs only a free account on the server and the phone), Cloudflare Tunnel (needs a domain on Cloudflare),
   or a Hetzner VPS with Caddy. The code is the same; the *verification* differs.
2. **Auth default**: always on (my proposal; one paste per browser, `SESSIONBOXER_AUTH=off` escape hatch) or
   only when `SESSIONBOXER_HOST` is not loopback (weaker: silently open behind `tailscale serve`/`cloudflared`).
3. **Trust proxy identity** (`Tailscale-User-Login` / Cloudflare Access) as a login method — include in stage
   1 or skip?
4. Stage order: 1 → 2 → 3 as above, or 1 + 2 together before you try it from the phone?
