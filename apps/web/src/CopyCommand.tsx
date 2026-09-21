import { useState } from "react";

/** A shell command shown as text one can select, with a button that puts it on the clipboard. */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(command).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  };
  return (
    <span className="copy-command">
      <code>{command}</code>
      <button type="button" className="link" onClick={copy}>
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}
