import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import appIconUrl from "./assets/app-icon.svg?url";
import "./styles.css";

const icon = document.querySelector<HTMLLinkElement>("link[rel='icon']") || document.createElement("link");
icon.rel = "icon";
icon.type = "image/svg+xml";
icon.href = appIconUrl;
document.head.appendChild(icon);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
