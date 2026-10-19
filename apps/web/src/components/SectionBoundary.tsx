import { Component, type ReactNode } from "react";
import { reportClientError } from "../clientErrors";

interface Props {
  /** What broke, in the reader's words ("This card", "The Models tab"). */
  label: string;
  children: ReactNode;
  /** A change (another card, tab or token) clears the error and renders the children again. */
  resetKey?: unknown;
  /** Shown as a Close button beside Try again: a modal that broke can still be dismissed. */
  onClose?: () => void;
  /** "card" keeps the fallback one line, for a slot in a list or a board column. */
  size?: "card" | "section";
}

interface State {
  error: Error | null;
  resetKey: unknown;
}

/**
 * A render error inside one card, tab or modal stays there: the section shows what happened and a
 * way to retry, and the rest of the page keeps working. ErrorBoundary (main.tsx) stays the last line
 * of defence for anything outside these.
 */
export class SectionBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.resetKey ? { error: null, resetKey: props.resetKey } : null;
  }

  componentDidCatch(error: Error) {
    console.error(`[${this.props.label}]`, error);
    reportClientError(this.props.label, error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { label, onClose, size = "section" } = this.props;
    const chunk = /dynamically imported module|Loading chunk|Importing a module script failed/i.test(
      error.message,
    );
    return (
      <div
        className={`section-crash${size === "card" ? " is-card" : ""}${onClose ? " is-modal" : ""}`}
        role="alert"
      >
        <span>
          {chunk
            ? `${label} didn't load. Reloading usually fixes it.`
            : `${label} hit an error and couldn't show.`}
        </span>
        <span className="row">
          <button
            className="ghost"
            onClick={() => (chunk ? location.reload() : this.setState({ error: null }))}
          >
            {chunk ? "Reload" : "Try again"}
          </button>
          {onClose && (
            <button className="ghost" onClick={onClose}>
              Close
            </button>
          )}
        </span>
      </div>
    );
  }
}
