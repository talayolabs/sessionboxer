import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** `X-Hub-Signature-256` (GitHub) / `X-Hub-Signature` (Bitbucket Data Center): `sha256=` + HMAC-SHA-256 of the raw body. */
export function verifyHookSignature(secret: string, rawBody: string, header: string | null | undefined): boolean {
  const m = /^sha256=([0-9a-f]{64})$/i.exec((header ?? "").trim());
  if (!m) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  const given = Buffer.from(m[1]!, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** What a delivery is about — only a hint of which PRs to poll; nothing else from the payload is used. */
export interface HookHint {
  owner: string;
  repo: string;
  numbers: number[];
}

const GhPayload = z
  .object({
    repository: z.object({ full_name: z.string() }).optional(),
    pull_request: z.object({ number: z.number().int() }).optional(),
    issue: z.object({ number: z.number().int(), pull_request: z.unknown().optional() }).optional(),
    check_run: z.object({ pull_requests: z.array(z.object({ number: z.number().int() })).default([]) }).optional(),
    check_suite: z.object({ pull_requests: z.array(z.object({ number: z.number().int() })).default([]) }).optional(),
  })
  .passthrough();

export function githubHookHint(rawBody: string): HookHint | null {
  const parsed = GhPayload.safeParse(tryJson(rawBody));
  if (!parsed.success || !parsed.data.repository) return null;
  const [owner, repo] = parsed.data.repository.full_name.split("/");
  if (!owner || !repo) return null;
  const numbers = new Set<number>();
  const d = parsed.data;
  if (d.pull_request) numbers.add(d.pull_request.number);
  if (d.issue?.pull_request) numbers.add(d.issue.number);
  for (const p of d.check_run?.pull_requests ?? []) numbers.add(p.number);
  for (const p of d.check_suite?.pull_requests ?? []) numbers.add(p.number);
  return { owner, repo, numbers: [...numbers] };
}

const BbPayload = z
  .object({
    pullRequest: z
      .object({
        id: z.number().int(),
        toRef: z.object({ repository: z.object({ slug: z.string(), project: z.object({ key: z.string() }) }) }),
      })
      .optional(),
    repository: z.object({ slug: z.string(), project: z.object({ key: z.string() }) }).optional(),
  })
  .passthrough();

export function bitbucketHookHint(rawBody: string): HookHint | null {
  const parsed = BbPayload.safeParse(tryJson(rawBody));
  if (!parsed.success) return null;
  const d = parsed.data;
  if (d.pullRequest) return { owner: d.pullRequest.toRef.repository.project.key, repo: d.pullRequest.toRef.repository.slug, numbers: [d.pullRequest.id] };
  if (d.repository) return { owner: d.repository.project.key, repo: d.repository.slug, numbers: [] };
  return null;
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
}
