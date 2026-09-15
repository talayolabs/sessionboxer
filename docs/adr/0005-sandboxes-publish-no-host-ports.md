# Sandboxes publish no host ports; everything is proxied through the Control Plane

Each Sandbox runs several network services (the daemon that fronts the Agent, x11vnc for the Desktop, whatever dev servers the Agent starts). The obvious Docker approach is to publish a random host port per service, but that leaks every Sandbox onto the host's network interfaces and makes URLs differ per Session. Instead, Sandboxes join a private Docker network with no published ports, and the Control Plane, which is the only process that listens on the host, dials them by container address and proxies WebSockets (chat stream, noVNC, terminals) under stable URLs such as `/sessions/:id/desktop`.

## Consequences

- One published port for the whole system; exposing Sessionboxer on a LAN or behind a reverse proxy is a single-port problem.
- Dev servers the Agent starts inside a Sandbox are reachable from the Desktop's browser, but not from the host, unless a per-port proxy is added later.
- The Control Plane must run where it can reach the Docker network (same host as the Docker daemon, or itself inside a container on that network).
