import { Component, type ReactNode } from "react";
import { EmptyState, ui } from "../components/ui";

interface Props {
  children: ReactNode;
}

interface State {
  failed: boolean;
}

/**
 * Catches a page that throws while rendering, so the header and navigation stay usable
 * instead of a blank window. The layout gives it the page's path as its key, so moving to
 * another page starts afresh. Nothing about the error is shown: it may hold game data.
 */
export class PageErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <EmptyState title="This page stopped working">
        <p>Something went wrong while showing it. Reloading usually helps.</p>
        <button type="button" className={ui.button} onClick={() => window.location.reload()}>
          Reload
        </button>
      </EmptyState>
    );
  }
}
