# A configurable address pool for the Docker daemon inside a Sandbox

A user on Windows + Cloudflare WARP + WSL2 could reach a private Argo CD (`172.17.74.12`) from the WSL shell and from a plain container on the `sessionboxer` network, but the Agent in a Docker-enabled Session reported *No route to host* while public sites worked. The box showed `172.17.0.0/16 dev docker0`: the dockerd that ADR-0008 starts inside the Sandbox takes Docker's default bridge range, so the kernel in the box treats every `172.17.x.x` host as a neighbour on that bridge, ARPs for it and gives up. Nothing about WARP or WSL is involved; any company or VPN host inside `172.16.0.0/12` is hidden the same way from any Docker-enabled Sandbox, and each `docker compose` network eats another /16 of it.

## Decision

**`Settings.sandboxDockerAddressPool`**, an IPv4 block of /8 to /24, **`192.168.240.0/20` by default**. When set, `Sessions.sandboxEnv` passes it as `SESSIONBOXER_DOCKER_POOL` to Docker-enabled Sandboxes and `entrypoint.sh` starts the inner daemon with `--bip <first /24 of it>.1/24 --default-address-pool base=<block>,size=24`, so `docker0` and every network created inside come out of that block. Empty means Docker's own defaults, as before. The value is validated by the protocol schema (a clear 400 rather than a daemon that fails to start), the field sits under **Docker inside Sandboxes** in Settings with a `<datalist>` of three candidates and a note on what to avoid (VPN, LAN, the outer Docker networks), and it applies to Sandboxes created afterwards: a resumed Sandbox keeps its daemon's existing networks.

**The default is the least-claimed block we know of, not Docker's.** No block is safe everywhere, so the pick is by elimination: `10.0.0.0/8` is the usual company network and Kubernetes (`10.96.0.0/12`, `10.244.0.0/16`), `172.16.0.0/12` is WSL2, Docker's own defaults and many VPNs, `100.64.0.0/10` is Tailscale and Cloudflare WARP, and in `192.168.0.0/16` home routers use the bottom (`192.168.0–2.x`, `192.168.100.x`, `192.168.178.x`) and Docker Desktop `192.168.65.x`. The top /20 of `192.168.x` (`192.168.240–255.x`) is left; sixteen /24 networks are plenty for one box. A user whose network does live there sets another block, or empties the field for Docker's default. The guide documents the symptom, the one-line check (`docker network inspect bridge` inside the box), the setting, and the separate `daemon.json` fix when the *outer* `sessionboxer` network overlaps instead.

**Not this ADR:** Cloudflare's documented Docker-under-WARP MTU adjustment (1500 → 1420 on Linux) is mentioned in the guide only; it was not the failure here and is left to the host's `daemon.json` until a real case needs it. Certificate errors after the route works are the CA-trust problem of ADR-0015.

## Considered Options

- **Move the outer `sessionboxer` network** (first hypothesis): the user's outer network was `192.168.65.0/24` and already reached the host; it is Docker's `default-address-pools` job and stays there.
- **Host networking for Sandboxes**: would drop the isolation ADR-0005 relies on; Cloudflare's own docs recommend a custom bridge instead.
- **A per-Session pool**: the inner daemon's networks are invisible to other Sessions, so one global block is enough; each Sandbox reuses the same addresses.
- **Detect overlaps automatically** (routes on the host, VPN ranges): the host cannot see what the user's VPN routes on Windows; a one-line setting with a documented check is the honest version.

## Consequences

- Private hosts in `172.16.0.0/12` become reachable from Docker-enabled Sessions created after the upgrade; a user with something in `192.168.240–255.x` has to change the field.
- Requires an image rebuild (`entrypoint.sh`) and re-creating Docker-enabled Sessions. `iproute2` is added to the image so `ip route` works in the box for this kind of diagnosis.
- Verified live: a fake host at `172.17.74.12` on the outer bridge was unreachable from a default Docker-enabled box and from a container inside it, and answered 200 from both once the pool was set (`10.213.0.0/16`, then the default: `docker0` at `192.168.240.0/24`, the next `docker network create` at `192.168.241.0/24`, nested route `172.17.74.12 via 192.168.240.1`).
