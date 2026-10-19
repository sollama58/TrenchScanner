/** Placeholder blocks with a shimmer, shaped like what is loading. */
export function Skeleton({ lines = 3, height = 14 }: { lines?: number; height?: number }) {
  return (
    <div className="skeleton-group" aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="skeleton" style={{ height, width: `${100 - ((i * 17) % 40)}%` }} />
      ))}
    </div>
  );
}

export function SkeletonCards({ count = 4 }: { count?: number }) {
  return (
    <div className="cards">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="card card-skeleton">
          <div className="row gap-s">
            <span className="skeleton round" style={{ width: 40, height: 40 }} />
            <Skeleton lines={2} />
          </div>
          <Skeleton lines={3} height={18} />
        </div>
      ))}
    </div>
  );
}
