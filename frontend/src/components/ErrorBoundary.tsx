import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallback: (error: Error, errorInfo?: ErrorInfo) => ReactNode
  resetKey?: string
}

interface State {
  error: Error | null
  errorInfo?: ErrorInfo
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ error, errorInfo })
  }

  componentDidUpdate(prevProps: Props) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null, errorInfo: undefined })
    }
  }

  render() {
    if (this.state.error) return this.props.fallback(this.state.error, this.state.errorInfo)
    return this.props.children
  }
}
