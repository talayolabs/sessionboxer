// ---------------------------------------------------------------------------
// USB devices (ADR-0055). A USB device of the Docker host's kernel (the Linux machine, or the
// WSL2 VM) can be connected to one Session at a time: its `/dev/bus/usb/BBB/DDD` node appears
// in that Sandbox and nowhere else, and follows the device when it re-enumerates.
// ---------------------------------------------------------------------------

import { z } from "zod";

/** A USB device as the Control Plane sees it (`GET /api/usb`). */
export const UsbDevice = z.object({
  /** Stable across re-plugs: `vendor:product:serial`, or `vendor:product@<bus-port>` for a device without a serial number. */
  id: z.string(),
  /** Manufacturer and product strings, or the Windows description on WSL2. */
  name: z.string(),
  vendorId: z.string(),
  productId: z.string(),
  serial: z.string().nullable(),
  /** `/dev/bus/usb/BBB/DDD` in the Docker host's kernel; `null` when only Windows knows it (WSL2, not attached yet). */
  node: z.string().nullable(),
  /** WSL2 hosts with usbipd-win: the Windows bus id, and whether the device is shared (`usbipd bind`) already. */
  wsl: z.object({ busId: z.string(), bound: z.boolean() }).nullable(),
  /** Session it is connected to. */
  sessionId: z.string().nullable(),
});
export type UsbDevice = z.infer<typeof UsbDevice>;

/** The Docker host's USB situation: what can be connected and how. */
export const UsbHost = z.object({
  /**
   * `linux`: devices plugged into the machine (or attached to the WSL2 VM by hand) are listed;
   * `wsl`: usbipd-win answers, so the Control Plane also lists Windows devices and attaches them itself;
   * `unsupported`: the Docker daemon runs in a VM the Control Plane cannot see into (Docker Desktop, Colima…).
   */
  kind: z.enum(["linux", "wsl", "unsupported"]),
  /** Why `unsupported`, or a hint about the setup (usbipd-win missing on WSL2). */
  note: z.string().nullable(),
  devices: z.array(UsbDevice),
});
export type UsbHost = z.infer<typeof UsbHost>;

/** The USB device connected to a Session. */
export const SessionUsb = z.object({
  id: z.string(),
  name: z.string(),
  vendorId: z.string(),
  productId: z.string(),
  serial: z.string().nullable(),
  /** The node inside the Sandbox; `null` while the device is unplugged (it comes back on re-plug). */
  node: z.string().nullable(),
  /** usbipd-win bus id the Control Plane attached to WSL2 for this Session (detached on disconnect); `null` otherwise. */
  wslBusId: z.string().nullable().default(null),
});
export type SessionUsb = z.infer<typeof SessionUsb>;

/** `POST /api/sessions/:id/usb`. */
export const UsbConnectRequest = z.object({ deviceId: z.string().min(1) });
export type UsbConnectRequest = z.infer<typeof UsbConnectRequest>;
