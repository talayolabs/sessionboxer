/** The little YAML the `gh` and Bitbucket hosts files use: one level of quoting, plain keys. */

export function unquote(s: string): string {
  const t = s.trim();
  if (t.startsWith('"')) {
    try {
      return String(JSON.parse(t));
    } catch {
      return t;
    }
  }
  return t.replace(/^'(.*)'$/, "$1");
}

export function yamlKey(s: string): string {
  return /^[A-Za-z0-9_.-]+$/.test(s) ? s : yamlString(s);
}

export function yamlString(s: string): string {
  return JSON.stringify(s);
}
