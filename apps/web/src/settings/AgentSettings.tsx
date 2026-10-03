import { DEFAULT_CLAUDE_MODELS, DEFAULT_HTML_APP_CDNS, DEFAULT_INSTRUCTIONS, type PublicSettings } from "@sessionboxer/protocol";
import { deliveryNote } from "../SessionSettingsForm";
import { Caption } from "../ui";
import { parseOriginList, useSectionState, type Setter } from "./shared";

/** Global settings → Agent: model aliases, the system prompt and the HTML app CDN allowlist. */
/** Form state of the Agent section; `SettingsView` spreads `values` and `set` into `<AgentSettings>`. */
export function useAgentSettings(settings: PublicSettings) {
  return useSectionState({
    claudeModels: settings.claudeModels.join(", "),
    instructions: settings.instructions,
    htmlAppCdns: settings.htmlAppCdns.join("\n"),
  });
}

export function AgentSettings({
  claudeModels,
  setClaudeModels,
  instructions,
  setInstructions,
  htmlAppCdns,
  setHtmlAppCdns,
}: {
  claudeModels: string;
  setClaudeModels: Setter<string>;
  instructions: string;
  setInstructions: Setter<string>;
  htmlAppCdns: string;
  setHtmlAppCdns: Setter<string>;
}) {
  return (
    <section className="ss-section" id="settings-models">
      <h3>
        <Caption help={<p>Defaults for the Agent of new Sessions; each Session sets its own model, fast mode, effort and system prompt on top.</p>}>
          Agent
        </Caption>
      </h3>
      <label>
        <Caption
          help={
            <p>
              Written to Claude&apos;s <code>availableModels</code> setting inside each Sandbox, so models your account has but the picker does
              not list by default (e.g. <code>fable</code>) become selectable; leave empty for Claude&apos;s built-in list. Aliases only, no
              keys. Applies to new Sessions and to idle running ones (their Agent restarts in place, keeping the conversation); Stop → Resume a
              Session if it does not pick it up.
            </p>
          }
        >
          Claude model aliases (comma-separated, offered in the Model picker)
        </Caption>
        <input value={claudeModels} onChange={(e) => setClaudeModels(e.target.value)} placeholder={DEFAULT_CLAUDE_MODELS.join(", ")} />
      </label>
      <label>
        <span className="label-row">
          <Caption
            help={
              <p>
                Given to the Agent itself rather than left in a file it may or may not read: {deliveryNote("claude-code")} {deliveryNote("devin")}{" "}
                {deliveryNote("codex")} {deliveryNote("cursor")} {deliveryNote("pi")} {deliveryNote("opencode")} {deliveryNote("fx")} {deliveryNote("kimi")} {deliveryNote("copilot")} {deliveryNote("vibe")} {deliveryNote("grok")} Comes on top of the Sandbox briefing (desktop, recordings, handing files to you)
                and the project&apos;s own CLAUDE.md / AGENTS.md. Empty sends none. Default for new Sessions; each Session can change it in its
                settings.
              </p>
            }
          >
            System prompt
          </Caption>
          {instructions !== DEFAULT_INSTRUCTIONS && (
            <button type="button" className="link" onClick={() => setInstructions(DEFAULT_INSTRUCTIONS)}>
              Reset to the shipped default
            </button>
          )}
        </span>
        <textarea rows={6} value={instructions} onChange={(e) => setInstructions(e.target.value)} spellCheck={false} />
      </label>
      <label>
        <span className="label-row">
          <Caption
            help={
              <p>
                A self-contained <code>.html</code> file the Agent writes under the Workspace runs as an app in the chat and in the App pane,
                sandboxed: no origin of its own, no network, except scripts, styles, images and fonts from these origins (one per line,
                scheme and host). Empty allows none. Applies to apps loaded from now on.
              </p>
            }
          >
            HTML app CDN allowlist
          </Caption>
          {parseOriginList(htmlAppCdns).join("\n") !== DEFAULT_HTML_APP_CDNS.join("\n") && (
            <button type="button" className="link" onClick={() => setHtmlAppCdns(DEFAULT_HTML_APP_CDNS.join("\n"))}>
              Reset to the shipped default
            </button>
          )}
        </span>
        <textarea rows={4} value={htmlAppCdns} onChange={(e) => setHtmlAppCdns(e.target.value)} spellCheck={false} placeholder="https://cdn.jsdelivr.net" />
      </label>
    </section>
  );
}
