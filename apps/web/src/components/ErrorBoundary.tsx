import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * App-level safety net: a render error in any page unmounts the whole tree
 * without one of these, wiping the UI to a blank screen. Renders the error
 * with a way back to the Library instead.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled render error', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <section className="page">
          <h1 className="page-title">Something went wrong</h1>
          <p className="page-description">
            An unexpected error occurred while rendering this page. The rest of the app is still
            available.
          </p>
          <pre className="form-error">{this.state.error.message}</pre>
          <div className="form-actions">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => {
                this.setState({ error: null })
              }}
            >
              Try again
            </button>
            <a className="btn" href="/">
              Back to Library
            </a>
          </div>
        </section>
      )
    }
    return this.props.children
  }
}
