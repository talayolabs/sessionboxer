import { PROVIDER_LABELS, type Provider } from "@sessionboxer/protocol";

// Hand-drawn approximations of the Providers' marks: Claude's orange starburst
// and Devin's three linked hexagons, drawn in the current text colour.

const CLAUDE_RAYS: ReadonlyArray<[angle: number, length: number]> = [
  [0, 9.5],
  [28, 8],
  [58, 9],
  [90, 9.5],
  [118, 7.5],
  [150, 9],
  [180, 9.5],
  [206, 8],
  [238, 9],
  [270, 9.5],
  [298, 7.5],
  [330, 9],
];

/** Flat-topped hexagon (vertices left and right) as SVG polygon points. */
function hexagon(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let k = 0; k < 6; k++) {
    const a = (Math.PI / 180) * (60 * k);
    pts.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy - r * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(" ");
}

const HEX_R = 5.2;
const HEX_DX = 4;
const HEX_DY = 5.5;
const DEVIN_HEXES = [hexagon(12 - HEX_DX, 12 - HEX_DY, HEX_R), hexagon(12 + HEX_DX, 12, HEX_R), hexagon(12 - HEX_DX, 12 + HEX_DY, HEX_R)];

export function ProviderIcon({ provider, size = 16 }: { provider: Provider; size?: number }) {
  const label = PROVIDER_LABELS[provider];
  switch (provider) {
    case "claude-code":
      return (
        <svg className="provider-icon" width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={label}>
          <title>{label}</title>
          <g stroke="#d97757" strokeWidth="2.4" strokeLinecap="round">
            {CLAUDE_RAYS.map(([angle, length]) => {
              const a = (Math.PI / 180) * angle;
              return <line key={angle} x1={12 + 2.2 * Math.cos(a)} y1={12 - 2.2 * Math.sin(a)} x2={12 + length * Math.cos(a)} y2={12 - length * Math.sin(a)} />;
            })}
          </g>
        </svg>
      );
    case "devin":
      return (
        <svg className="provider-icon" width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={label}>
          <title>{label}</title>
          <g fill="currentColor">
            {DEVIN_HEXES.map((points) => (
              <polygon key={points} points={points} />
            ))}
          </g>
        </svg>
      );
  }
}
