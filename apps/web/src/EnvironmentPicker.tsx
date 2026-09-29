import { useEffect, useState } from "react";
import { ENVIRONMENTS, ENVIRONMENT_LABELS, PROVIDER_LABELS, type Environment, type RecentSnapshot } from "@sessionboxer/protocol";
import { api } from "./api";
import { EnvironmentIcon } from "./EnvironmentIcon";
import { ago } from "./PullRequests";
import { Select, type SelectOption } from "./ui";

const PICKED_KEY = "sessionboxer.new.snapshots";
const PICKED_MAX = 10;

/** Snapshots picked lately on this browser: listed even once they fall out of the newest twenty. */
function pickedIds(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(PICKED_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function rememberPickedSnapshot(id: string): void {
  localStorage.setItem(PICKED_KEY, JSON.stringify([id, ...pickedIds().filter((x) => x !== id)].slice(0, PICKED_MAX)));
}

/** The newest Snapshots of every Session plus the ones picked lately (and `current`, so an old pick still shows), newest first. */
export function useRecentSnapshots(current: string | null): RecentSnapshot[] {
  const [snapshots, setSnapshots] = useState<RecentSnapshot[]>([]);
  useEffect(() => {
    let live = true;
    void api.recentSnapshots([...pickedIds(), ...(current ? [current] : [])]).then(
      (list) => {
        if (live) setSnapshots(list);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [current]);
  return snapshots;
}

export function snapshotLabel(s: RecentSnapshot): string {
  return `${s.sessionTitle} · snapshot ${s.ordinal}`;
}

export interface EnvironmentPick {
  environment: Environment;
  /** Start from this Snapshot's image (ADR-0069); `environment` is then the Snapshot's. */
  snapshotId: string | null;
}

/**
 * Where a new Session's Sandbox comes from, in one dropdown: a fresh Environment under "New"
 * (Docker · Linux, QEMU · Windows, QEMU · macOS), then "Recent snapshots" — the newest twenty of
 * every Session and the ones picked lately — each starting a Sandbox from that image with an
 * empty conversation. Used by the New session toolbar, its Advanced dialog and the automations'
 * New Session action.
 */
export function EnvironmentPicker({
  value,
  disabled,
  compact,
  environmentOption,
  onEnvironment,
  onSnapshot,
}: {
  value: EnvironmentPick;
  disabled?: boolean;
  /** Toolbar form: the icon alone, the pick in a tooltip. */
  compact?: boolean;
  /** Per Environment: why it cannot be picked here, or a hint. */
  environmentOption: (env: Environment) => Pick<SelectOption<string>, "hint" | "disabled">;
  onEnvironment: (environment: Environment) => void;
  onSnapshot: (snapshot: RecentSnapshot) => void;
}) {
  const snapshots = useRecentSnapshots(value.snapshotId);
  const picked = value.snapshotId ? (snapshots.find((s) => s.id === value.snapshotId) ?? null) : null;
  const options: SelectOption<string>[] = [
    ...ENVIRONMENTS.map((env) => ({
      value: `env:${env}`,
      label: ENVIRONMENT_LABELS[env],
      icon: <EnvironmentIcon environment={env} />,
      group: "New",
      ...environmentOption(env),
    })),
    ...snapshots.map((s) => ({
      value: `snap:${s.id}`,
      label: snapshotLabel(s),
      textValue: snapshotLabel(s),
      icon: <EnvironmentIcon environment={s.environment} />,
      group: "Recent snapshots",
      hint: `${ago(s.createdAt)} · ${PROVIDER_LABELS[s.provider]} · ${ENVIRONMENT_LABELS[s.environment]}`,
    })),
  ];
  const tip = picked
    ? `From snapshot: ${snapshotLabel(picked)} (${ENVIRONMENT_LABELS[picked.environment]})`
    : value.snapshotId
      ? "From a snapshot"
      : `Environment: ${ENVIRONMENT_LABELS[value.environment]}`;
  return (
    <Select<string>
      value={value.snapshotId ? `snap:${value.snapshotId}` : `env:${value.environment}`}
      disabled={disabled}
      aria-label="Environment or snapshot"
      tip={compact ? tip : undefined}
      className={compact ? "compact icon-only" : undefined}
      menuClassName="env-pick-menu"
      placeholder={value.snapshotId ? "From a snapshot…" : undefined}
      options={options}
      onChange={(v) => {
        const env = ENVIRONMENTS.find((e) => `env:${e}` === v);
        if (env) {
          onEnvironment(env);
          return;
        }
        const s = snapshots.find((x) => `snap:${x.id}` === v);
        if (s) {
          rememberPickedSnapshot(s.id);
          onSnapshot(s);
        }
      }}
    >
      {compact ? (
        <span className="env-pick">
          <EnvironmentIcon environment={value.environment} />
          {value.snapshotId && <span className="env-pick-snap" aria-hidden="true">📷</span>}
        </span>
      ) : undefined}
    </Select>
  );
}
