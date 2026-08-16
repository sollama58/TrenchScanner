import type { Token, TokenSnapshot } from "@trenchscanner/core";

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(2)}`;
}

export function formatRealtimeAlert(token: Token, snapshot: TokenSnapshot, score: number): string {
  const name = token.name ?? token.symbol ?? token.mintAddress.slice(0, 8);
  const dexUrl = `https://dexscreener.com/solana/${token.pairAddress ?? token.mintAddress}`;
  const lines = [
    `🎯 <b>${escapeHtml(name)}${token.symbol ? ` ($${escapeHtml(token.symbol)})` : ""}</b>`,
    `Score: <b>${score.toFixed(0)}/100</b>`,
    `Market cap: ${fmtUsd(snapshot.marketCapUsd)}`,
    snapshot.volume24hUsd !== null ? `24h volume: ${fmtUsd(snapshot.volume24hUsd)}` : undefined,
    snapshot.holderCount !== null ? `Holders: ${snapshot.holderCount}` : undefined,
    "",
    `<a href="${dexUrl}">View on DexScreener</a>`,
    `<code>${token.mintAddress}</code>`,
  ].filter((l): l is string => l !== undefined);
  return lines.join("\n");
}

export function formatDigest(entries: { token: Token; snapshot: TokenSnapshot; score: number }[]): string {
  if (entries.length === 0) {
    return "No new matches in the last 24h. TrenchScanner is still watching.";
  }
  const header = `📋 <b>Daily digest — ${entries.length} match${entries.length === 1 ? "" : "es"} in the last 24h</b>\n`;
  const rows = entries
    .sort((a, b) => b.score - a.score)
    .map((e) => {
      const name = e.token.name ?? e.token.symbol ?? e.token.mintAddress.slice(0, 8);
      return `• <b>${escapeHtml(name)}</b> — score ${e.score.toFixed(0)}, mcap ${fmtUsd(e.snapshot.marketCapUsd)}`;
    });
  return [header, ...rows].join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
