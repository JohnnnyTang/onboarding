import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/global.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(
  <StrictMode>
    <main>
      <h1>Board Game Platform</h1>
    </main>
  </StrictMode>,
);
