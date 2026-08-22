import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"

// vitest/config's defineConfig extends vite's, so the `test` block is typed.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
  },
  test: {
    environment: "jsdom",
    globals: false,
  },
})
