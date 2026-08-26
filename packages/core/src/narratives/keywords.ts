/**
 * Lightweight narrative/theme tagging. This is intentionally simple keyword
 * matching against name/symbol/description text - no external NLP or social
 * API (v1 scope, see PLANNING.md). Good enough to group tokens into broad
 * recognizable categories and to support user-defined keyword filters.
 */

const NARRATIVE_TAXONOMY: Record<string, string[]> = {
  dog: ["dog", "doge", "shiba", "inu", "puppy", "corgi", "retriever"],
  cat: ["cat", "kitty", "kitten", "meow"],
  frog: ["frog", "pepe", "toad"],
  ai: ["ai", "agent", "gpt", "llm", "neural", "robot"],
  political: ["trump", "biden", "president", "election", "senate", "maga"],
  elon: ["elon", "musk", "tesla", "spacex", "grok", "xai"],
  sports: ["nba", "nfl", "soccer", "football", "olympic", "fifa"],
  finance: ["bull", "bear", "moon", "pump", "chart", "wallstreet"],
  celebrity: ["kanye", "drake", "mrbeast", "kardashian"],
  based: ["based", "chad", "sigma", "alpha"],
};

export function extractNarrativeTags(input: {
  name?: string;
  symbol?: string;
  description?: string;
}): string[] {
  const haystack = `${input.name ?? ""} ${input.symbol ?? ""} ${input.description ?? ""}`.toLowerCase();
  const tags: string[] = [];
  for (const [tag, keywords] of Object.entries(NARRATIVE_TAXONOMY)) {
    if (keywords.some((kw) => containsWord(haystack, kw))) {
      tags.push(tag);
    }
  }
  return tags;
}

/** True if any of the user's free-text keywords appears in the token's name/symbol/tags. No keywords = always matches. */
export function matchesNarrativeKeywords(
  token: { name?: string; symbol?: string; description?: string; narrativeTags: string[] },
  userKeywords: string[] | undefined,
): boolean {
  if (!userKeywords || userKeywords.length === 0) return true;
  const haystack =
    `${token.name ?? ""} ${token.symbol ?? ""} ${token.description ?? ""} ${token.narrativeTags.join(" ")}`.toLowerCase();
  return userKeywords.some((kw) => haystack.includes(kw.toLowerCase().trim()));
}

function containsWord(haystack: string, word: string): boolean {
  // Cheap word-ish boundary check without a regex-injection risk from dynamic input,
  // since `word` here always comes from our own static taxonomy above.
  return new RegExp(`\\b${word}\\b`, "i").test(haystack);
}
