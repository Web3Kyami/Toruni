import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import { WalletConnectionProvider } from "./wallet/WalletConnectionProvider";
import "./ui/styles.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Toruni root element is missing.");

createRoot(rootElement).render(
  <StrictMode>
    <WalletConnectionProvider>
      <App />
    </WalletConnectionProvider>
  </StrictMode>,
);
