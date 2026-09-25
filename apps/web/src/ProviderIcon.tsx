import { PROVIDER_LABELS, type Provider } from "@sessionboxer/protocol";

// Hand-drawn approximations of the Providers' marks: Claude's orange starburst,
// Devin's three linked hexagons and Codex's (OpenAI's) hexagonal knot, drawn in
// the current text colour.

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

/** Six rounded arcs around the centre, each turned 60 degrees further: OpenAI's knot, loosely. */
const CODEX_ARC = "M 12 3.4 C 15.2 3.4 17.4 5.6 17.4 8.4 L 17.4 12";
const CODEX_TURNS = [0, 60, 120, 180, 240, 300];
/** Cursor's mark is an isometric cube: a hexagon whose three visible faces meet at the centre, each shaded differently. */
const CURSOR_HEX = [0, 60, 120, 180, 240, 300].map((deg) => {
  const a = (Math.PI / 180) * (deg - 90);
  return `${(12 + 9 * Math.cos(a)).toFixed(2)},${(12 + 9 * Math.sin(a)).toFixed(2)}`;
});
const CURSOR_FACES: { corners: [number, number, number]; opacity: number }[] = [
  { corners: [0, 1, 2], opacity: 0.45 },
  { corners: [2, 3, 4], opacity: 0.7 },
  { corners: [4, 5, 0], opacity: 1 },
];

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
    case "codex":
      return (
        <svg className="provider-icon" width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={label}>
          <title>{label}</title>
          <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            {CODEX_TURNS.map((deg) => (
              <path key={deg} d={CODEX_ARC} transform={`rotate(${deg} 12 12)`} />
            ))}
          </g>
        </svg>
      );
    case "cursor":
      return (
        <svg className="provider-icon" width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={label}>
          <title>{label}</title>
          <g fill="currentColor">
            {CURSOR_FACES.map(({ corners, opacity }) => (
              <polygon key={opacity} points={`${corners.map((i) => CURSOR_HEX[i]).join(" ")} 12,12`} opacity={opacity} />
            ))}
          </g>
          <polygon points={CURSOR_HEX.join(" ")} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
      );
  }
}
