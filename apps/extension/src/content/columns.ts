/**
 * Which column of a board a row sits in (user ask 2026-10-25), for the safety option's choice of
 * columns: new coins, coins about to graduate, and graduated ones. Rows in no column (Trending,
 * Discover and other lists) are "other".
 *
 * Terminal marks each row with its column (`data-trenches-item="SOLANA:<mint>-NEW"`). Elsewhere a
 * column is found from its heading (Axiom's Pulse: New Pairs, Final Stretch, Migrated): the
 * nearest box around the heading that holds rows is that column, unless it holds another heading.
 * Headings count only when the page has two kinds or more, as a board does.
 */
export const BOARD_COLUMNS = ["new", "soon", "graduated", "other"] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

const HEADINGS: [RegExp, BoardColumn][] = [
  [/^(new pairs|new|new creations|newly created|new tokens)$/i, "new"],
  [/^(final stretch|about to graduate|graduating|almost bonded|completing|bonding|soon)$/i, "soon"],
  [/^(migrated|graduated|completed|bonded)$/i, "graduated"],
];

/** A Terminal row's column, from the suffix of its mark. */
export function columnOfMark(mark: string): BoardColumn | null {
  const suffix = /-([A-Z_]+)$/.exec(mark)?.[1];
  if (!suffix) return null;
  if (suffix === "NEW") return "new";
  if (/GRADUATED|MIGRATED|BONDED|COMPLETED/.test(suffix)) return "graduated";
  if (/GRADUATING|BONDING|STRETCH|ALMOST|SOON|FINAL|COMPLETING/.test(suffix)) return "soon";
  return null;
}

export function columnOfHeading(text: string): BoardColumn | null {
  const t = text.trim();
  if (t.length > 24) return null;
  return HEADINGS.find(([re]) => re.test(t))?.[1] ?? null;
}

/** The columns' boxes on a page, each with its column. */
export function findColumns(root: Document, rows: readonly Element[]): [Element, BoardColumn][] {
  const rowSet = new Set(rows);
  const inRow = (el: Element) => {
    for (let a: Element | null = el; a; a = a.parentElement) if (rowSet.has(a)) return true;
    return false;
  };
  const headings: [Element, BoardColumn][] = [];
  const walker = root.createTreeWalker(root.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const column = columnOfHeading(node.textContent ?? "");
    const el = node.parentElement;
    // A tab or button saying "New" (a filter on a Trending list) is no column's heading.
    if (column && el && !inRow(el) && !el.closest("button, a, [role='tab']")) headings.push([el, column]);
  }
  // A board shows at least two of the columns; one heading alone is a badge or a title.
  if (new Set(headings.map(([, c]) => c)).size < 2) return [];
  const out: [Element, BoardColumn][] = [];
  for (const [heading, column] of headings) {
    for (let box = heading.parentElement; box && box !== root.body; box = box.parentElement) {
      if (!rows.some((r) => box.contains(r))) continue;
      // A box around two headings is the board, not a column.
      if (!headings.some(([h, c]) => h !== heading && c !== column && box.contains(h)))
        out.push([box, column]);
      break;
    }
  }
  return out;
}

/** A row's column: its own mark, else the column box around it, else "other". */
export function columnOf(row: Element, boxes: readonly [Element, BoardColumn][]): BoardColumn {
  const mark = row.matches("[data-trenches-item]") ? row : row.querySelector("[data-trenches-item]");
  const marked = mark ? columnOfMark(mark.getAttribute("data-trenches-item") ?? "") : null;
  if (marked) return marked;
  return boxes.find(([box]) => box.contains(row))?.[1] ?? "other";
}
