/** Docker's whale, drawn in `currentColor`; used only as a warning mark for `--privileged` Sandboxes. */
export function DockerIcon({ size = 16, label }: { size?: number; label: string }) {
  return (
    <svg className="docker-icon" width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={label}>
      <title>{label}</title>
      <g fill="currentColor">
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
