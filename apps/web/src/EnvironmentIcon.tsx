import { ENVIRONMENT_LABELS, type Environment } from "@sessionboxer/protocol";

// The marks of a Session's Environment (ADR-0057/0059), 16 px by default: the OS is the main glyph,
// the runtime that boots it (Docker, QEMU) a small badge at its bottom-right corner. Brand colours
// where the mark is known by them (Docker blue, Windows blue, QEMU orange), `currentColor` for Apple.

const DOCKER_BLUE = "#2496ed";
const WINDOWS_BLUE = "#0078d4";
const QEMU_ORANGE = "#ff6600";

/** Docker's whale in brand blue (the red `currentColor` one in DockerIcon.tsx is the --privileged warning). */
export function DockerLogo({ size = 16, color = DOCKER_BLUE }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <g fill={color}>
        <rect x="5" y="9" width="3" height="3" rx="0.4" />
        <rect x="8.5" y="9" width="3" height="3" rx="0.4" />
        <rect x="12" y="9" width="3" height="3" rx="0.4" />
        <rect x="8.5" y="5.5" width="3" height="3" rx="0.4" />
        <rect x="12" y="5.5" width="3" height="3" rx="0.4" />
        <rect x="12" y="2" width="3" height="3" rx="0.4" />
        <path d="M22.4 10.6c-.9-.6-2.3-.7-3.4-.4-.2-1.1-.9-2-1.9-2.6l-.4-.2-.3.4c-.5.6-.7 1.5-.6 2.3.1.5.3 1 .6 1.4-.4.2-.9.4-1.4.4H1.4c-.4 0-.7.3-.7.7 0 1.5.2 3 .8 4.3.6 1.4 1.5 2.4 2.7 3 1.3.7 3.4 1.1 5.8 1.1 1.1 0 2.2-.1 3.2-.3 1.5-.3 2.9-.8 4.1-1.6 1-.6 1.9-1.4 2.6-2.4.9-1.2 1.5-2.5 1.9-3.9h.3c1.1 0 1.8-.4 2.2-.8.2-.2.4-.5.5-.8l.1-.3z" />
      </g>
    </svg>
  );
}

/** QEMU's mark, loosely: the orange disc with the bird's beak cut out of it and its eye. */
export function QemuLogo({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 2a10 10 0 1 0 6.8 17.3l3.6 2.2-1.5-4.2A10 10 0 0 0 12 2z"
        fill={QEMU_ORANGE}
      />
      <path d="M8.5 7.2c1.2 0 2.3.4 3 1.2 1.2 1.3 1.1 3 .6 4.6l4.9 1.3-5.8 1.4c-1.6.4-3.4-.2-4.3-1.6-1.1-1.8-.8-4.4.6-6a2 2 0 0 1 1-.9z" fill="#fff" opacity="0.92" />
      <circle cx="9.2" cy="9.4" r="1" fill={QEMU_ORANGE} />
    </svg>
  );
}

/** Windows' four-pane flag in brand blue. */
export function WindowsLogo({ size = 16, color = WINDOWS_BLUE }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2 5.3l8.2-1.1v7.9H2zM11.2 4.1L22 2.5v9.6H11.2zM2 12.9h8.2v7.9L2 19.7zM11.2 12.9H22v9.6l-10.8-1.6z" fill={color} />
    </svg>
  );
}

/** Apple's mark in the current text colour. */
export function AppleLogo({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M16.4 12.7c0-2.2 1.8-3.3 1.9-3.3-1-1.5-2.6-1.7-3.2-1.7-1.4-.1-2.6.8-3.3.8-.7 0-1.7-.8-2.8-.7-1.5 0-2.8.8-3.6 2.1-1.5 2.6-.4 6.5 1.1 8.6.7 1 1.6 2.2 2.7 2.2 1.1 0 1.5-.7 2.8-.7s1.7.7 2.8.7c1.2 0 1.9-1.1 2.6-2.1.8-1.2 1.2-2.4 1.2-2.4s-2.2-.9-2.2-3.5z"
        fill="currentColor"
      />
      <path d="M14.3 6.2c.6-.7 1-1.8.9-2.8-.9 0-1.9.6-2.6 1.3-.6.7-1.1 1.7-.9 2.7 1 .1 2-.5 2.6-1.2z" fill="currentColor" />
    </svg>
  );
}

/** Tux, simplified: a black body with the white belly and the orange beak. */
export function LinuxLogo({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2c-2.6 0-4.2 2.1-4.2 5 0 1.2-.4 2.3-1.1 3.4C5.5 12.3 4 14.4 4 17c0 1.4.8 2.4 1.9 3-.4.5-.6 1.1-.4 1.6.3.6 1.1.6 2 .4l2-.5c.8.3 1.6.5 2.5.5s1.7-.2 2.5-.5l2 .5c.9.2 1.7.2 2-.4.2-.5 0-1.1-.4-1.6 1.1-.6 1.9-1.6 1.9-3 0-2.6-1.5-4.7-2.7-6.6-.7-1.1-1.1-2.2-1.1-3.4 0-2.9-1.6-5-4.2-5z" fill="currentColor" />
      <path d="M12 9.6c-2 0-3.6 2.6-3.6 5.4 0 2.3 1.6 3.9 3.6 3.9s3.6-1.6 3.6-3.9c0-2.8-1.6-5.4-3.6-5.4z" fill="var(--panel, #fff)" />
      <path d="M10.2 8.3l1.8 1.5 1.8-1.5-1.8-.9z" fill={QEMU_ORANGE} />
      <circle cx="10.5" cy="6.4" r="0.8" fill="var(--panel, #fff)" />
      <circle cx="13.5" cy="6.4" r="0.8" fill="var(--panel, #fff)" />
    </svg>
  );
}

/**
 * The Environment's mark: the OS as the main glyph, the runtime as a badge in the corner — Tux with the
 * Docker whale, the Windows flag or the Apple with QEMU's disc. Legible at 16 px; `size` scales both.
 */
export function EnvironmentIcon({ environment, size = 16, label }: { environment: Environment; size?: number; label?: string }) {
  const badge = Math.round(size * 0.56);
  const main = environment === "docker-linux" ? <LinuxLogo size={size} /> : environment === "qemu-windows" ? <WindowsLogo size={size} /> : <AppleLogo size={size} />;
  const runtime = environment === "docker-linux" ? <DockerLogo size={badge} /> : <QemuLogo size={badge} />;
  return (
    <span className="env-icon" style={{ width: size, height: size }} role="img" aria-label={label ?? ENVIRONMENT_LABELS[environment]}>
      {main}
      <span className="env-icon-badge" style={{ width: badge, height: badge }}>
        {runtime}
      </span>
    </span>
  );
}
