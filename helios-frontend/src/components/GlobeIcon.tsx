import { useId } from "react";

/**
 * Web search status icons. The globe is Feather's; Feather has no globe-x,
 * so that one (after Phosphor's GlobeX, on request) is drawn in Feather's
 * style: the same globe at the same size, with an x cut into its lower right.
 */
const GLOBE = (
  <>
    <circle cx="12" cy="12" r="10" />
    <line x1="2" y1="12" x2="22" y2="12" />
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </>
);

type Props = { size?: number; strokeWidth?: number; className?: string };

function Svg({
  size = 16,
  strokeWidth = 1.75,
  className,
  children,
}: Props & { children: React.ReactNode }) {
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
      {children}
    </svg>
  );
}

export function GlobeIcon(props: Props) {
  return <Svg {...props}>{GLOBE}</Svg>;
}

export function GlobeXIcon(props: Props) {
  const cut = useId();
  return (
    <Svg {...props}>
      <mask id={cut}>
        {/* No stroke: the svg's grey stroke would leave a faint ring. */}
        <rect width="24" height="24" fill="white" stroke="none" />
        <circle cx="19" cy="19" r="5" fill="black" stroke="none" />
      </mask>
      {/* The globe at full size, as in GlobeIcon, so toggling only swaps the
          x in; the x is cut into its lower right. */}
      <g mask={`url(#${cut})`}>{GLOBE}</g>
      <path d="M16.75 16.75l4.5 4.5M21.25 16.75l-4.5 4.5" />
    </Svg>
  );
}
