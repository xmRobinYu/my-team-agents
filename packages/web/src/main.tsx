import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./components/PiApp";
// Load order matters: styles.css holds the base tokens and the P6/P7a surfaces,
// styles-rooms.css the I8 group layout — including the narrow-screen overrides
// that must win over the base three-column grid.
import "./styles.css";
import "./styles-rooms.css";

const container = document.getElementById("root");
if (!container) throw new Error("找不到 #root 挂载点");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
