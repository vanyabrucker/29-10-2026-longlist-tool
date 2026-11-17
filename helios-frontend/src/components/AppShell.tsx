"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { AdminPanel } from "@/components/admin/AdminPanel";
import { CompaniesPanel } from "@/components/Companies";
import { LonglistsPanel } from "@/components/Longlists";
import { SettingsPanel } from "@/components/Settings";
import { Sidebar } from "@/components/Sidebar";
import { Workspace } from "@/components/Workspace";
import { useUser } from "@/lib/auth";
import { ChatProvider } from "@/lib/chat";

// The sidebar and workspace live here so they stay mounted across /, /c/[id].
// Pages under this group render nothing; the workspace and the settings panel
// read the URL themselves.
export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  // undefined until the gateway answers, then the signed-in user or null.
  const user = useUser();

  // The admin area is dev-only; anyone else is sent home.
  const blocked = !!user && pathname.startsWith("/admin") && !user.is_dev;
  useEffect(() => {
    if (user === null) router.replace("/login");
    else if (blocked) router.replace("/");
  }, [user, blocked, router]);

  if (!user) return null;

  return (
    <ChatProvider>
      <div className="flex h-screen bg-canvas pt-1">
        <Sidebar user={user} />
        {pathname.startsWith("/settings") ? (
          <SettingsPanel />
        ) : pathname.startsWith("/companies") ? (
          <CompaniesPanel />
        ) : pathname.startsWith("/longlists") ? (
          <LonglistsPanel />
        ) : pathname.startsWith("/admin") ? (
          blocked ? null : (
            <AdminPanel />
          )
        ) : (
          <Workspace />
        )}
        {children}
      </div>
    </ChatProvider>
  );
}
