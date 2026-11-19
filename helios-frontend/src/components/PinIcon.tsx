/**
 * Feather has no pushpin, so this one is drawn in Feather's style (24px box,
 * round 1.75 strokes): an angled thumbtack, filled on pinned rows. Taken
 * from the dev branch.
 */
export function PinIcon({
  size = 15,
  strokeWidth = 1.75,
  className,
  filled,
}: {
  size?: number;
  strokeWidth?: number;
  className?: string;
  filled?: boolean;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {/* Drawn upright, then rotated so the needle points down-left. */}
      <g transform="rotate(45 12 12)">
        <path d="M12 15v7" />
        <path
          d="M9 2h6a1 1 0 0 1 1 1v2l-1.5 2v3.5L18 14v1H6v-1l3.5-3.5V7L8 5V3a1 1 0 0 1 1-1z"
          fill={filled ? "currentColor" : "none"}
        />
      </g>
    </svg>
  );
}
