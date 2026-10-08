import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TokenSagePage } from "./TokenSagePage";
import "../fonts.css";
import "../styles.css";
import "./tokensage.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TokenSagePage />
  </StrictMode>,
);
