import { describe, expect, it } from "vitest";
import { PRIVY_PORTAL_ROOT_ID, placePrivyLayer } from "./privyLayer";

/** Just enough of the DOM for placePrivyLayer: a tree of elements with ids, `open` and `inert`. */
class El {
  parentElement: El | null = null;
  children: El[] = [];
  inert = false;
  constructor(
    readonly tag: string,
    readonly id = "",
    public open = false,
  ) {}
  appendChild(child: El): El {
    child.parentElement?.children.splice(child.parentElement.children.indexOf(child), 1);
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  *walk(): Generator<El> {
    for (const c of this.children) {
      yield c;
      yield* c.walk();
    }
  }
}

function page() {
  const body = new El("body");
  const app = body.appendChild(new El("div", "root"));
  const popup = app.appendChild(new El("dialog", "pop"));
  const doc = {
    body,
    getElementById: (id: string) => [...body.walk()].find((e) => e.id === id) ?? null,
    querySelectorAll: () => [...body.walk()].filter((e) => e.tag === "dialog" && e.open),
  };
  /** What Privy does when its window opens: a container on <body>, and the app marked inert. */
  const privyOpens = () => {
    const root = body.appendChild(new El("div", PRIVY_PORTAL_ROOT_ID));
    app.inert = true;
    return root;
  };
  return { body, app, popup, doc: doc as unknown as Document, privyOpens };
}

describe("placePrivyLayer", () => {
  it("moves Privy's window into the open popup, so it can be clicked over it", () => {
    const { app, popup, doc, privyOpens } = page();
    popup.open = true;
    const root = privyOpens();
    placePrivyLayer(doc);
    expect(root.parentElement).toBe(popup);
    // The app holds the popup and now the window: it can't stay inert.
    expect(app.inert).toBe(false);
  });

  it("uses the top popup when one is open over another", () => {
    const { app, popup, doc, privyOpens } = page();
    popup.open = true;
    const twoFactor = app.appendChild(new El("dialog", "2fa", true));
    const root = privyOpens();
    placePrivyLayer(doc);
    expect(root.parentElement).toBe(twoFactor);
  });

  it("leaves Privy's window on the page when no popup is open, and puts it back when the popup closes", () => {
    const { body, app, popup, doc, privyOpens } = page();
    const root = privyOpens();
    placePrivyLayer(doc);
    expect(root.parentElement).toBe(body);
    // Privy's own inert mark stays: there is no popup, and the page behind its window is off limits.
    expect(app.inert).toBe(true);

    popup.open = true;
    placePrivyLayer(doc);
    expect(root.parentElement).toBe(popup);
    popup.open = false;
    placePrivyLayer(doc);
    expect(root.parentElement).toBe(body);
  });

  it("does nothing while Privy has no window up", () => {
    const { app, popup, doc } = page();
    popup.open = true;
    app.inert = true;
    placePrivyLayer(doc);
    expect(app.inert).toBe(true);
  });
});
