import { useEffect } from 'react'

/**
 * React Router doesn't touch <title> on navigation, so without this every
 * route reads "Skillbox" in the tab strip, history, and bookmarks. Call once
 * per page with a title fragment; restores the previous title on unmount so
 * a page that unmounts mid-navigation doesn't leave a stale tab title.
 */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    const previous = document.title
    document.title = `${title} · Skillbox`
    return () => {
      document.title = previous
    }
  }, [title])
}
