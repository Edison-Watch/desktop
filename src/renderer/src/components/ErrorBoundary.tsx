import { Component } from "react";
import type { ReactNode, ErrorInfo } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  override render() {
    if (this.state.error) {
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "100vh",
            backgroundColor: "#0B0E14",
            color: "#F87171",
            fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
            padding: "2rem",
            textAlign: "center",
          }}
        >
          <div
            style={{
              fontSize: "2rem",
              marginBottom: "1rem",
            }}
          >
            Something went wrong
          </div>
          <pre
            style={{
              maxWidth: "80%",
              overflow: "auto",
              fontSize: "0.8rem",
              color: "#9CA3AF",
              background: "#1a1f2e",
              padding: "1rem",
              borderRadius: "0.5rem",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {this.state.error.message}
            {this.state.error.stack && `\n\n${this.state.error.stack}`}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}
