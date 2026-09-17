const MB = 1024 ** 2;

/** Bytes as a short MB figure ("<1 MB", "12.4 MB", "980 MB", "2.3 GB"). */
export function formatMb(bytes: number): string {
  if (bytes < MB) return "<1 MB";
  const mb = bytes / MB;
  if (mb >= 10_240) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb >= 100 ? mb.toFixed(0) : mb.toFixed(1)} MB`;
}

/** Exact-ish file size ("312 B", "26 KB", "4.2 MB"), for single files rather than disk totals. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`;
  return formatMb(bytes);
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
