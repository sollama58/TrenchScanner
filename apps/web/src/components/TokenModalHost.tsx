import { lazy, Suspense, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useNow } from "../hooks";
import { closeTokenModal, openTokenModalState, subscribeTokenModal } from "../tokenModal";

// The token modal (and its chart) loads the first time a card is opened.
const TokenModal = lazy(() => import("./TokenModal").then((m) => ({ default: m.TokenModal })));

/** Shows the token modal a feed card opened; mounted once, so it outlives the card. */
export function TokenModalHost() {
  const open = useSyncExternalStore(subscribeTokenModal, openTokenModalState);
  // Ages keep counting after the card that opened the modal has left the feed.
  const tick = useNow(15_000);
  if (!open) return null;
  return createPortal(
    <Suspense fallback={null}>
      {/* Keyed by card, so opening another card's modal starts it fresh. */}
      <TokenModal
        key={open.card.id}
        card={open.card}
        now={Math.max(open.now, tick)}
        onClose={closeTokenModal}
      />
    </Suspense>,
    document.body,
  );
}
