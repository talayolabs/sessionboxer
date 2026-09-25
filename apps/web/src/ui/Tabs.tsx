import type { ComponentProps } from "react";
import { Tabs as RadixTabs } from "radix-ui";

/**
 * Tabs that select one panel among several (Radix Tabs): arrow keys move between the tabs, the aria
 * relationships are wired, the inactive panels are not rendered. Controlled: `value` + `onValueChange`.
 * The root is a plain `div` (`className` lays it out; `contents` makes it transparent to the parent's flex),
 * the list takes the look (`segmented`, `tab-strip`, `split-nav`), a panel takes its own (`split-body`).
 *
 * Header tabs that toggle a pane off and the phone's bottom tabs stay hand-written: they are not a
 * one-of-N selection.
 */
export function Tabs<V extends string>({
  value,
  onValueChange,
  ...props
}: Omit<ComponentProps<typeof RadixTabs.Root>, "value" | "onValueChange" | "defaultValue"> & {
  value: V;
  onValueChange: (value: V) => void;
}) {
  return <RadixTabs.Root value={value} onValueChange={(v) => onValueChange(v as V)} {...props} />;
}

export function TabList(props: ComponentProps<typeof RadixTabs.List>) {
  return <RadixTabs.List {...props} />;
}

export function Tab(props: ComponentProps<typeof RadixTabs.Trigger>) {
  return <RadixTabs.Trigger {...props} />;
}

/** A panel; not a tab stop itself (its controls are), pass `tabIndex={0}` for a read-only scrolling one. */
export function TabPanel(props: ComponentProps<typeof RadixTabs.Content>) {
  return <RadixTabs.Content tabIndex={-1} {...props} />;
}
