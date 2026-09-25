import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AuthGate } from "./Auth";
import { initTheme } from "./theme";
import { TooltipProvider } from "./ui";
import "./styles/tokens.css";
import "./styles/base.css";
import "./ui/ui.css";
import "./styles.css";

initTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <AuthGate>
        <App />
      </AuthGate>
    </TooltipProvider>
  </StrictMode>,
);
