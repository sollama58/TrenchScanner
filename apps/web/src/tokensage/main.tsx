import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { startVersionWatch } from "../version";
import { TokenSagePage } from "./TokenSagePage";
import "../fonts.css";
import "../styles.css";
import "./tokensage.css";

// No update banner on this page; only the reload when a deploy removed a chunk it asks for.
startVersionWatch();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TokenSagePage />
  </StrictMode>,
);
