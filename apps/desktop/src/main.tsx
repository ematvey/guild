import "./lib/openui-devtools-off";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import "./scroll-activity";
import { ensureServiceWorker, resubmitSubscription } from "./lib/push";

ensureServiceWorker();
void resubmitSubscription();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
