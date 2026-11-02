// Ensure window.fetch has both getter and setter for third-party extensions/interceptors
try {
  let _fetch = window.fetch;
  if (!Object.getOwnPropertyDescriptor(window, "fetch")?.set) {
    Object.defineProperty(window, "fetch", {
      configurable: true,
      enumerable: true,
      get: () => _fetch,
      set: (val) => { _fetch = val; }
    });
  }
} catch (e) {}

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
