import React from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import "./styles.css";
import { applyTheme, readThemePref, resolveTheme } from "./lib/theme.js";

// Apply the theme before the first render so a dark-mode browser never flashes light.
applyTheme(resolveTheme(readThemePref()));

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
