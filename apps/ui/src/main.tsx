import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "./theme.css";
import "./pos-tokens.css";
import "./pos.css";
import "./captain.css";
import { applyTheme, readTheme } from "./theme";
import { startCaptainPwa } from "./captain-pwa";
import { startKitchenPwa } from "./kitchen-pwa";

// The customer menu has its own restaurant branding and color palette.
if (!/^\/menu\/?$/.test(window.location.pathname)) applyTheme(readTheme());
startCaptainPwa();
startKitchenPwa();

createRoot(document.getElementById("root")!).render(<App />);
