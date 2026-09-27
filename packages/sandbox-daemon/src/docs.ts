import { readFile } from "node:fs/promises";
import { GUIDE_PATH } from "@sessionboxer/protocol";

const MAX_SECTIONS = 3;
const MAX_SECTION_CHARS = 6000;

interface Section {
  heading: string;
  /** Headings of the enclosing sections, outermost first. */
  path: string[];
  text: string;
}

/**
 * The `docs` tool: the user guide shipped in the image (`GUIDE_PATH`), split by heading; the sections
 * whose heading matches the query rank first, then those whose text mentions its words most.
 */
export class Docs {
  private sections: Promise<Section[]> | null = null;

  constructor(
    private readonly path = GUIDE_PATH,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  async lookup(query: string): Promise<{ query: string; sections: Array<{ heading: string; path: string; text: string }>; headings?: string[] }> {
    const sections = await this.load();
    const words = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 1);
    const scored = sections
      .map((s) => ({ s, score: score(s, words) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SECTIONS);
    if (scored.length === 0) return { query, sections: [], headings: sections.map((s) => s.heading) };
    return {
      query,
      sections: scored.map(({ s }) => ({ heading: s.heading, path: [...s.path, s.heading].join(" › "), text: s.text.length > MAX_SECTION_CHARS ? `${s.text.slice(0, MAX_SECTION_CHARS)}…` : s.text })),
    };
  }

  private load(): Promise<Section[]> {
    this.sections ??= readFile(this.path, "utf8").then(splitSections, (e: unknown) => {
      this.log(`guide not readable at ${this.path}: ${String(e)}`);
      this.sections = null;
      throw new Error(`The user guide is not available in this Sandbox (${this.path}).`);
    });
    return this.sections;
  }
}

function score(s: Section, words: string[]): number {
  const heading = s.heading.toLowerCase();
  const text = s.text.toLowerCase();
  let total = 0;
  for (const w of words) {
    if (heading.includes(w)) total += 10;
    const hits = text.split(w).length - 1;
    total += Math.min(hits, 5);
  }
  return total;
}

export function splitSections(markdown: string): Section[] {
  const out: Section[] = [];
  const stack: Array<{ level: number; heading: string }> = [];
  let current: (Section & { level: number }) | null = null;
  let fence = false;
  for (const line of markdown.split("\n")) {
    if (/^```/.test(line)) fence = !fence;
    const m = fence ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      const level = m[1]!.length;
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
      current = { heading: m[2]!, level, path: stack.map((s) => s.heading), text: "" };
      out.push(current);
      stack.push({ level, heading: m[2]! });
      continue;
    }
    if (current) current.text += (current.text ? "\n" : "") + line;
  }
  return out.map((s) => ({ heading: s.heading, path: s.path, text: s.text.trim() }));
}
