import { Component, type ReactNode } from "react";
import { ThisIsFine } from "./ThisIsFine";

/**
 * The last line of defence: a render error (a missing API field, say) or a code chunk that failed
 * to download would otherwise unmount the whole app to a blank page. This shows what happened and
 * a way back instead. A deploy that removed a chunk is handled earlier, by the version watch.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const chunk = /dynamically imported module|Loading chunk|Importing a module script failed/i.test(
      error.message,
    );
    return (
      <ThisIsFine
        title={chunk ? "Part of the page didn't load" : "Something went wrong on this page"}
        actions={
          <>
            <button className="primary" onClick={() => location.reload()}>
              Reload
            </button>
            <button
              onClick={() => {
                location.hash = "";
                location.reload();
              }}
            >
              Back to Live
            </button>
          </>
        }
      >
        {chunk
          ? "The connection dropped while loading. Reloading usually fixes it."
          : "Reload to try again. If it keeps happening, report it with the bug button once the page is back."}
      </ThisIsFine>
    );
  }
}
