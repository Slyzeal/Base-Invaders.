import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";

// Tell Warpcast the app is ready to display
async function init() {
  try {
    const { sdk } = await import("https://esm.sh/@farcaster/miniapp-sdk@latest");
    await sdk.actions.ready();
  } catch {
    // Not inside Warpcast — ignore
  }
}

init();

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);
