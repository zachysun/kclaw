/**
 * Content type for an attachment upload, guessed from the filename (coarse but
 * enough). Shared by chat's `/attach` and `kclaw run --attach`, which upload
 * through the same route.
 */
import { extname } from "node:path"

export function mimeForFile(name: string): string {
  const ext = extname(name).toLowerCase()
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(ext)) return "image/" + ext.slice(1)
  if (ext === ".pdf") return "application/pdf"
  if (ext === ".md" || ext === ".markdown") return "text/markdown"
  if ([".txt", ".json", ".csv", ".yaml", ".yml", ".log", ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".sh"].includes(ext)) return "text/plain"
  return "application/octet-stream"
}
