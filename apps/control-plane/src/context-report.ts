import type { ContextBreakdown, ContextCategory, ContextCategoryKind, ContextContributor, Provider } from "@sessionboxer/protocol";

/**
 * Parses the Agent's `/context` report (ADR-0030). Two dialects:
 *
 * Claude Code prints markdown — `**Model:** …`, `**Tokens:** 30.1k / 1m (3%)`, then tables
 * under `### Estimated usage by category`, `### MCP Tools`, `### Memory Files`, `### Skills`.
 *
 * Devin prints a block-character grid with a legend on the right — a header line
 * `` `swe-2-high` · 12.3k/262.0k tokens (4.7%) `` and one `█ Name   5.9k   (2.2%)` per
 * category, `░ Free …` for the remainder — followed by a `Note:` line.
 *
 * Anything the parser does not recognise is simply absent; the raw text travels along.
 */
export function parseContextReport(provider: Provider, text: string): ContextBreakdown {
  const base: ContextBreakdown = {
    provider,
    model: null,
    totalTokens: null,
    maxTokens: null,
    percent: null,
    categories: [],
    mcpTools: [],
    memoryFiles: [],
    skills: [],
    note: null,
    text,
  };
  return /^\s*\|.*\|\s*$/m.test(text) || /\*\*Tokens:\*\*/.test(text) ? parseMarkdown(base) : parseGrid(base);
}

/** `8.8k`, `1m`, `~480`, `1.1k`, `5`, `249.7k` → tokens; `null` when it is not a number. */
export function parseTokens(s: string): number | null {
  const m = /^~?\s*([\d,]*\.?\d+)\s*([kKmM]?)$/.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const unit = m[2]!.toLowerCase();
  return Math.round(n * (unit === "k" ? 1000 : unit === "m" ? 1_000_000 : 1));
}

function parsePercent(s: string): number | null {
  const m = /([\d.]+)\s*%/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export function categoryKind(name: string): ContextCategoryKind {
  const n = name.toLowerCase();
  if (/^free\b/.test(n)) return "free";
  if (/buffer/.test(n)) return "buffer";
  if (/deferred/.test(n)) return "deferred";
  return "used";
}

/** Rows of a markdown table: the cells of every `| a | b |` line after the header and its `|---|` rule. */
function tableRows(lines: string[]): string[][] {
  const rows: string[][] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith("|")) {
      if (rows.length > 0 || t !== "") break;
      continue;
    }
    if (/^\|[\s:-]+(\|[\s:-]+)*\|?$/.test(t)) continue;
    rows.push(
      t
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => c.trim()),
    );
  }
  // The first row is the header.
  return rows.slice(1);
}

/** The lines following the `### Heading` whose text matches `re`, up to the next heading. */
function section(lines: string[], re: RegExp): string[] {
  const start = lines.findIndex((l) => /^#{2,4}\s/.test(l) && re.test(l));
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{2,4}\s/.test(l));
  return end < 0 ? rest : rest.slice(0, end);
}

function parseMarkdown(base: ContextBreakdown): ContextBreakdown {
  const lines = base.text.split(/\r?\n/);
  const out = { ...base };
  const model = /\*\*Model:\*\*\s*(\S+)/.exec(base.text);
  if (model) out.model = model[1]!;
  const tokens = /\*\*Tokens:\*\*\s*([~\d.,]+[kKmM]?)\s*\/\s*([~\d.,]+[kKmM]?)\s*(?:\(([\d.]+)%\))?/.exec(base.text);
  if (tokens) {
    out.totalTokens = parseTokens(tokens[1]!);
    out.maxTokens = parseTokens(tokens[2]!);
    out.percent = tokens[3] !== undefined ? Number(tokens[3]) : null;
  }
  out.categories = tableRows(section(lines, /categor/i)).flatMap((r): ContextCategory[] => {
    const [name, tok, pct] = r;
    const n = tok !== undefined ? parseTokens(tok) : null;
    if (!name || n === null) return [];
    return [{ name, tokens: n, percent: pct !== undefined ? parsePercent(pct) : null, kind: categoryKind(name) }];
  });
  const contributors = (rows: string[][], nameCol: number, sourceCol: number, tokensCol: number): ContextContributor[] =>
    rows.flatMap((r): ContextContributor[] => {
      const name = r[nameCol];
      const tok = r[tokensCol];
      const n = tok !== undefined ? parseTokens(tok) : null;
      if (!name || n === null) return [];
      return [{ name, source: r[sourceCol] ?? "", tokens: n }];
    });
  out.mcpTools = contributors(tableRows(section(lines, /mcp tools/i)), 0, 1, 2);
  // `| Type | Path | Tokens |`: the path is the name, the type its source.
  out.memoryFiles = contributors(tableRows(section(lines, /memory files/i)), 1, 0, 2);
  out.skills = contributors(tableRows(section(lines, /skills/i)), 0, 1, 2);
  const note = lines.find((l) => /^\s*\*?_?Note:/i.test(l));
  if (note) out.note = note.trim();
  return out;
}

function parseGrid(base: ContextBreakdown): ContextBreakdown {
  const out = { ...base };
  const lines = base.text.split(/\r?\n/);
  const head = /`([^`]+)`\s*[·•-]\s*([~\d.,]+[kKmM]?)\s*\/\s*([~\d.,]+[kKmM]?)\s*tokens\s*(?:\(([\d.]+)%\))?/.exec(base.text);
  if (head) {
    out.model = head[1]!;
    out.totalTokens = parseTokens(head[2]!);
    out.maxTokens = parseTokens(head[3]!);
    out.percent = head[4] !== undefined ? Number(head[4]) : null;
  }
  const categories: ContextCategory[] = [];
  for (const line of lines) {
    // Strip the grid on the left (and the legend's own swatch), keep "Name   5.9k   (2.2%)".
    const legend = line.replace(/^[\s█░▓▒■□▪▫]+/u, "").trim();
    const m = /^(.+?)\s{2,}([~\d.,]+[kKmM]?)\s+\(([\d.]+)%\)\s*$/.exec(legend) ?? /^(.+?)\s+([~\d.,]+[kKmM]?)\s+\(([\d.]+)%\)\s*$/.exec(legend);
    if (!m) continue;
    const n = parseTokens(m[2]!);
    if (n === null) continue;
    const name = m[1]!.trim();
    categories.push({ name, tokens: n, percent: Number(m[3]), kind: categoryKind(name) });
  }
  out.categories = categories;
  const note = lines.find((l) => /^\s*Note:/i.test(l));
  if (note) out.note = note.trim();
  return out;
}
