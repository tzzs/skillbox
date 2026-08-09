import type { ReactNode } from 'react'

/**
 * Small presentational helpers shared by the pages: loading, error and empty
 * states. Errors carry the M10.8 title from the API client (`ApiError`).
 */
export function CenteredHint({ children }: { children: ReactNode }) {
  return <div className="hint">{children}</div>
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="error-state" role="alert">
      <span className="error-title">Something went wrong</span>
      <p>{message || 'The server did not provide a reason.'}</p>
    </div>
  )
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string
  body: string
  action?: ReactNode
}) {
  return (
    <div className="empty-state">
      <h2>{title}</h2>
      <p>{body}</p>
      {action}
    </div>
  )
}
