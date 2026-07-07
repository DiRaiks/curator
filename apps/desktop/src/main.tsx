import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { loadShellTheme } from "./components/shell/types";
import "./styles.css";
import "./shell.css";

// Paint the document/window background from the persisted theme before
// React mounts, so the native OS titlebar (which reflects the window
// background) matches from the first frame — including the pre-vault
// Welcome screen. Dashboard keeps this in sync on theme toggle.
document.documentElement.style.background =
  loadShellTheme() === "porcelain" ? "#eceef2" : "#0e0f12";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
