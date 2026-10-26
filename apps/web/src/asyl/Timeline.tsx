import { useEffect, useMemo, useRef, useState } from "react";
import { timelineSteps, type AsylGraph } from "./graph";

/** How long the replay holds each step. */
const STEP_MS = 280;

const when = (ms: number) =>
  new Date(ms).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }) + " UTC";

/**
 * The timeline scrubber (user ask 2026-10-26): drag or play the map through time, so who funded
 * whom, who bought, and who sold appear in the order they happened. Links without a date stay.
 */
export function Timeline({
  graph,
  until,
  onUntil,
  onClose,
}: {
  graph: AsylGraph;
  until: number;
  onUntil: (ms: number) => void;
  onClose: () => void;
}) {
  const steps = useMemo(() => timelineSteps(graph), [graph]);
  const [playing, setPlaying] = useState(false);
  const at = useRef(until);
  at.current = until;
  // Where the slider sits: the last step at or before the moment.
  let index = 0;
  while (index + 1 < steps.length && steps[index + 1]! <= until) index++;
  const drawn = graph.edges.filter((e) => !e.at || Date.parse(e.at) <= until).length;

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      const next = steps.find((t) => t > at.current);
      if (next === undefined) setPlaying(false);
      else onUntil(next);
    }, STEP_MS);
    return () => clearInterval(id);
  }, [playing, steps, onUntil]);

  if (steps.length === 0)
    return (
      <div className="asyl-timeline" role="group" aria-label="Timeline">
        <span className="asyl-muted">No link on this map has a date to replay.</span>
        <button className="asyl-icon-btn" onClick={onClose} aria-label="Close the timeline">
          ×
        </button>
      </div>
    );
  const play = () => {
    // From the start when it's at the end.
    if (until >= steps[steps.length - 1]!) onUntil(steps[0]!);
    setPlaying((p) => !p);
  };
  return (
    <div className="asyl-timeline" role="group" aria-label="Timeline">
      <button className="asyl-btn ghost" onClick={play} aria-label={playing ? "Pause" : "Play"}>
        {playing ? "❚❚" : "▶"}
      </button>
      <input
        type="range"
        min={0}
        max={steps.length - 1}
        value={index}
        aria-label="When"
        onChange={(e) => {
          setPlaying(false);
          onUntil(steps[Number(e.target.value)]!);
        }}
      />
      <span className="asyl-timeline-when">
        <b>{when(steps[index]!)}</b>
        <span className="asyl-muted asyl-small">
          {drawn} of {graph.edges.length} links
        </span>
      </span>
      <button
        className="asyl-icon-btn"
        onClick={onClose}
        aria-label="Close the timeline"
        title="Show everything again"
      >
        ×
      </button>
    </div>
  );
}
