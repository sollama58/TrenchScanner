import type { ReactNode } from "react";

/**
 * The full-page "something broke" screen: the "This is Fine" dog fills the frame, with what
 * happened and the way out laid over its lower edge. The clip is a 113 KB looped MP4 in public/
 * (the 1.5 MB GIF it came from would cost a broken page more than it's worth; the WebM is for
 * browsers without H.264), served from this
 * site so it plays even when the rest of the bundle didn't load. Reduced motion shows the still.
 * public/404.html is the same layout for paths the host doesn't serve.
 */
export function ThisIsFine({
  title,
  children,
  actions,
  inShell = false,
}: {
  title: string;
  children: ReactNode;
  actions: ReactNode;
  /** Inside the app's header, footer and <main>, rather than the whole window. */
  inShell?: boolean;
}) {
  const Frame = inShell ? "section" : "main";
  const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  return (
    <Frame className={inShell ? "fine fine-shell" : "fine"} role="alert">
      <video
        className="fine-clip"
        poster="/this-is-fine.jpg"
        autoPlay={!still}
        loop
        muted
        playsInline
        disablePictureInPicture
        aria-hidden="true"
      >
        <source src="/this-is-fine.mp4" type="video/mp4" />
        <source src="/this-is-fine.webm" type="video/webm" />
      </video>
      <div className="fine-copy">
        <h1>{title}</h1>
        <p>{children}</p>
        <div className="row">{actions}</div>
      </div>
    </Frame>
  );
}
