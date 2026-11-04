import { Suspense } from "react";
import { AppShell } from "@/components/AppShell";

// The shell reads the URL (usePathname) and the stored login, so it only
// renders in the browser; on /c/[id] that bailout must sit inside Suspense
// or the production build fails to prerender the route.
export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <Suspense fallback={null}>
      <AppShell>{children}</AppShell>
    </Suspense>
  );
}
