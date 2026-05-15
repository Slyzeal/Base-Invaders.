import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";

// Signal to Farcaster/Warpcast that the app is ready
// This replaces the SDK's sdk.actions.ready() call
window.addEventListener("load", () => {
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: "frameReady" }, "*");
    }
  } catch {}
});

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);
