import { GlobeIcon, SendIcon, XLogoIcon } from "./Icons";
import { XLinkPreview } from "./XLinkPreview";

/** Where a coin's own links come from: a feed card's token or the token view's profile read. */
export interface SocialSource {
  twitterUrl?: string | null;
  telegramUrl?: string | null;
  websiteUrl?: string | null;
}

const https = (u: string | null | undefined) => {
  if (!u) return null;
  try {
    return new URL(u).protocol === "https:" ? u : null;
  } catch {
    return null;
  }
};

/**
 * The coin's own X, Telegram and website (user ask 2026-10-18): only the links it has, and only
 * https ones, whatever the source stored. X first, then Telegram, then the website.
 */
export function socialLinks(token: SocialSource) {
  return [
    { key: "x", label: "X", Icon: XLogoIcon, url: https(token.twitterUrl) },
    { key: "tg", label: "Telegram", Icon: SendIcon, url: https(token.telegramUrl) },
    { key: "web", label: "Website", Icon: GlobeIcon, url: https(token.websiteUrl) },
  ].filter((l): l is typeof l & { url: string } => l.url !== null);
}

export type SocialLink = ReturnType<typeof socialLinks>[number];

/**
 * The coin's own links as one row of same-size icon buttons, the same on a feed card, a Scope row
 * and the token view (user ask 2026-10-23): one box size, one icon size, one gap, centred on the
 * line beside them. X links preview the account on hover or a long press.
 */
export function SocialLinks({ links, className = "" }: { links: SocialLink[]; className?: string }) {
  if (links.length === 0) return null;
  return (
    <span className={`social-links ${className}`.trim()}>
      {links.map((l) => (
        <XLinkPreview
          key={l.key}
          className="social-link"
          href={l.url}
          target="_blank"
          rel="noopener noreferrer nofollow"
          title={`${l.label}: ${l.url.replace(/^https:\/\//, "").replace(/\/$/, "")}`}
          aria-label={`Open the coin's ${l.label}`}
        >
          <l.Icon size={12} />
        </XLinkPreview>
      ))}
    </span>
  );
}
