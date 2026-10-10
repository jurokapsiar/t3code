// Global CSS must load first so its cascade-layer order is declared before any CSS module.
import "./index.css";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";

createRoot(document.getElementById("root")!).render(<App />);
