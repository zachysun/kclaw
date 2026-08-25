import { createRoot } from "react-dom/client"
import { App } from "./App.js"
import { OfflineBanner, registerServiceWorker } from "./offlineBanner.js"
import "./index.css"

registerServiceWorker()

const root = document.getElementById("root")
if (root === null) throw new Error("missing #root element")
createRoot(root).render(
  <>
    <OfflineBanner />
    <App />
  </>,
)
