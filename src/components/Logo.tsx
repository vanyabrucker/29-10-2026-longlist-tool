// Placeholder brand mark: a plain light-blue square.
export function Logo({ className = "" }: { className?: string }) {
  return <span aria-hidden className={`inline-block bg-brand ${className}`} />;
}
