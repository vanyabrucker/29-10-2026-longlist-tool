"use client";

import { usePathname } from "next/navigation";
import { ImportDetailPanel } from "./ImportDetail";
import { ImportsPanel } from "./Imports";
import { MasterPanel } from "./Master";

/** The dev-only area (/admin/imports, /admin/imports/[id], /admin/master).
 * Like the other panels, it reads the URL itself; the pages render nothing. */
export function AdminPanel() {
  const pathname = usePathname();
  const detail = pathname.match(/^\/admin\/imports\/([^/]+)/);
  if (detail) return <ImportDetailPanel key={detail[1]} id={detail[1]} />;
  if (pathname.startsWith("/admin/master")) return <MasterPanel />;
  return <ImportsPanel />;
}
