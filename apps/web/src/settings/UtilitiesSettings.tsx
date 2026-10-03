import type { PublicUtilityDef, ProcedureDef, UtilityEnvironment } from "@sessionboxer/protocol";
import { UtilitiesEditor } from "../UtilitiesEditor";
import { Caption } from "../ui";
import type { Setter } from "./shared";

const UTILITIES_DOCS = "https://sessionboxer.talayolabs.com/guide/#utilities";

/** Global settings → Utilities: the Utilities, their Environments and procedures. */
export function UtilitiesSettings({
  utilities,
  setUtilities,
  utilityEnvironments,
  setUtilityEnvironments,
  procedures,
  setProcedures,
}: {
  utilities: PublicUtilityDef[];
  setUtilities: Setter<PublicUtilityDef[]>;
  utilityEnvironments: UtilityEnvironment[];
  setUtilityEnvironments: Setter<UtilityEnvironment[]>;
  procedures: ProcedureDef[];
  setProcedures: Setter<ProcedureDef[]>;
}) {
  return (
    <section className="ss-section" id="settings-utilities">
      <h3>
        <Caption
          help={
            <p>
              What Agents may investigate with: observability systems (New Relic, Grafana, Graylog, Argo CD…) and applications (a QA web app, an
              admin UI, a database, an SSH host), each in a target Environment (prod, staging, qa) with its credentials and facets (web UI,
              HTTP API, SSH, CLI, MCP server). A Session switches them on by group, Environment or one by one; the Agent reads the list in{" "}
              <code>.sessionboxer/utilities.json</code> and uses credentials by name (<code>{"${util:<name>.password}"}</code>, <code>sb-util</code>)
              without seeing them. Credentials are write-only here and never enter the chat. Agents can register Utilities too
              (<code>utilities_add</code>; you allow each in the chat) and propose procedures. See{" "}
              <a href={UTILITIES_DOCS} target="_blank" rel="noreferrer">
                the guide
              </a>
              .
            </p>
          }
        >
          Utilities
        </Caption>
      </h3>
      <UtilitiesEditor
        utilities={utilities}
        environments={utilityEnvironments}
        procedures={procedures}
        onUtilities={setUtilities}
        onEnvironments={setUtilityEnvironments}
        onProcedures={setProcedures}
      />
    </section>
  );
}
