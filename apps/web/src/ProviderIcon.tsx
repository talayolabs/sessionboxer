import { PROVIDER_LABELS, type Provider } from "@sessionboxer/protocol";

// Hand-drawn approximations of the Providers' marks: Claude's orange starburst,
// Devin's three linked hexagons, Codex's (OpenAI's) hexagonal knot, pi's π in
// a rounded square, OpenCode's pixel terminal, fx's lowercase "fx" wordmark
// (fx.sh), GitHub Copilot's goggled face, Mistral's blocky "M", Grok's slanted slash mark and Gemini's four-pointed star, drawn in the current text colour.

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

/** Mistral's "M" as [column, row, lighter] squares on a 5×5 grid: full-height outer columns, the diagonals meeting in the middle. */
const MISTRAL_BLOCKS: ReadonlyArray<[col: number, row: number, light: boolean]> = [
  [0, 0, false],
  [4, 0, false],
  [0, 1, false],
  [1, 1, true],
  [3, 1, true],
  [4, 1, false],
  [0, 2, false],
  [1, 2, true],
  [2, 2, true],
  [3, 2, true],
  [4, 2, false],
  [0, 3, false],
  [2, 3, true],
  [4, 3, false],
  [0, 4, false],
  [4, 4, false],
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

/** pi's mark: the Greek letter π, filled, inside a rounded square. */
const PI_GLYPH = "M 6.2 8.3 L 17.8 8.3 L 17.8 10.3 L 15.9 10.3 L 15.9 15.1 C 15.9 15.8 16.2 16.1 16.8 16.1 C 17.1 16.1 17.4 16 17.7 15.9 L 17.7 17.6 C 17.2 17.9 16.6 18 16 18 C 14.4 18 13.7 17.1 13.7 15.4 L 13.7 10.3 L 10.9 10.3 L 10.9 17.9 L 8.7 17.9 L 8.7 10.3 L 6.2 10.3 Z";

/**
 * OpenCode's mark (its favicon, 512 grid): a tall rectangle ring, 128..384 × 96..416, hollow at
 * 192..320 × 160..352, the lower half of the hollow (from 224) filled grey, scaled to 24.
 */
const OPENCODE_RING = "M6 4.5h12v15H6Z M9 7.5v9h6v-9Z";
const OPENCODE_BLOCK = { x: 9, y: 10.5, width: 6, height: 6 };

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
    case "pi":
      return (
        <svg className="provider-icon" width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={label}>
          <title>{label}</title>
          <rect x="2.5" y="2.5" width="19" height="19" rx="4.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d={PI_GLYPH} fill="currentColor" />
        </svg>
      );
    case "opencode":
      return (
        <svg className="provider-icon" width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={label}>
          <title>{label}</title>
          <path d={OPENCODE_RING} fill="currentColor" fillRule="evenodd" />
          <rect {...OPENCODE_BLOCK} fill="currentColor" opacity={0.45} />
        </svg>
      );
    case "kimi":
      return (
        <svg className="provider-icon" width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={label}>
          <title>{label}</title>
          <path d="M5 4v16m13-16L8 13m3-3 8 10" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "fx":
      // fx's wordmark: a lowercase "f" with its crossbar and a lowercase "x", as on fx.sh.
      return (
        <svg className="provider-icon" width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={label}>
          <title>{label}</title>
          <g fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 6.2c-1.8 0-3 1.1-3 3.1V20" />
            <path d="M4.2 11.5h6.3" />
            <path d="M13.5 11.5 20.2 20" />
            <path d="M20.2 11.5 13.5 20" />
          </g>
        </svg>
      );
    case "copilot":
      // Copilot's mark: a rounded helmet with two goggle lenses.
      return (
        <svg className="provider-icon" width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={label}>
          <title>{label}</title>
          <path
            d="M12 3.6c-4.5 0-7.4 2.3-7.4 6v1.3C3.7 11.2 3 12 3 13v2.5c0 1 .6 1.8 1.5 2.1 1.2 2 4.1 3 7.5 3s6.3-1 7.5-3c.9-.3 1.5-1.1 1.5-2.1V13c0-1-.7-1.8-1.6-2.1V9.6c0-3.7-2.9-6-7.4-6z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
          <rect x="6.4" y="10.6" width="4.2" height="4.6" rx="1.6" fill="currentColor" />
          <rect x="13.4" y="10.6" width="4.2" height="4.6" rx="1.6" fill="currentColor" />
        </svg>
      );
    case "vibe":
      // Mistral's mark: an "M" built of squares on a 5×5 grid, the inner diagonals lighter.
      return (
        <svg className="provider-icon" width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={label}>
          <title>{label}</title>
          <g fill="currentColor">
            {MISTRAL_BLOCKS.map(([col, row, light]) => (
              <rect key={`${col}-${row}`} x={2 + col * 4} y={2 + row * 4} width={4} height={4} opacity={light ? 0.55 : 1} />
            ))}
          </g>
        </svg>
      );
    case "grok":
      // Grok's mark: a long slash with a short one across its top, as on grok.com (xAI's logo).
      return (
        <svg className="provider-icon" width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={label}>
          <title>{label}</title>
          <g fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19.5 4.5 5 19.5" />
            <path d="M12.3 4.5 18.8 11.3" />
            <path d="M5 12.6 11.5 19.5" />
          </g>
        </svg>
      );
    case "gemini":
      // Gemini's mark: a four-pointed star with concave sides.
      return (
        <svg className="provider-icon" width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={label}>
          <title>{label}</title>
          <path d="M12 2C12 7.52 16.48 12 22 12C16.48 12 12 16.48 12 22C12 16.48 7.52 12 2 12C7.52 12 12 7.52 12 2Z" fill="currentColor" />
        </svg>
      );
  }
}
