import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/index.css";
import { installEditingKeyGuard } from "./lib/editing-keys";

// Before any component adds its own keydown listener: text-editing shortcuts belong to the field.
installEditingKeyGuard();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
