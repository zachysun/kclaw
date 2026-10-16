/**
 * Shared directory-picker state for the two create-session entries (the
 * sidebar's 选择工作目录 button and the chat empty state's 新建会话 button):
 * one loader plus the open/close flag, so both entries bind DirectoryPicker
 * without duplicating the listing/loading/error plumbing. onBrowse comes
 * from the daemon client; picking a directory IS the create gesture, so the
 * consumer turns picker.listing.path into its own onCreate call.
 */
import { useCallback, useState } from "react"
import type { FsBrowseResult } from "../types.js"

export interface DirectoryPickerState {
  open: boolean
  listing: FsBrowseResult | null
  loading: boolean
  error: string | null
  /** Open the picker and load the daemon's configured workspace as root. */
  openAtRoot: () => void
  /** Load one directory (picker-internal navigation). */
  load: (path?: string) => Promise<void>
  close: () => void
}

export function useDirectoryPicker(onBrowse: (path?: string) => Promise<FsBrowseResult>): DirectoryPickerState {
  const [open, setOpen] = useState(false)
  const [listing, setListing] = useState<FsBrowseResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async (path?: string): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      setListing(await onBrowse(path))
    } catch (err) {
      setError(err instanceof Error ? err.message : "目录读取失败")
    } finally {
      setLoading(false)
    }
  }

  const openAtRoot = () => {
    setOpen(true)
    setListing(null)
    void load(undefined)
  }

  // Stable identity: it rides the Escape keydown effect's dependency array in
  // DirectoryPicker.
  const close = useCallback((): void => setOpen(false), [])

  return { open, listing, loading, error, openAtRoot, load, close }
}
