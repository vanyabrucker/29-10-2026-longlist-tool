"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";
import { SettingsPanel } from "@/components/Settings";
import { Sidebar } from "@/components/Sidebar";
import { Workspace } from "@/components/Workspace";
import { getUser } from "@/lib/auth";
import { ChatProvider } from "@/lib/chat";

const subscribe = () => () => {};

// The sidebar and workspace live here so they stay mounted across /, /c/[id].
// Pages under this group render nothing; the workspace and the settings panel
// read the URL themselves.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  // undefined on the server / first paint, then the stored email or null.
  const user = useSyncExternalStore(subscribe, getUser, () => undefined);

  useEffect(() => {
    if (user === null) router.replace("/login");
  }, [user, router]);

  if (!user) return null;

  return (
    <ChatProvider>
      <div className="flex h-screen bg-canvas pt-1">
        <Sidebar user={user} />
        {pathname.startsWith("/settings") ? <SettingsPanel /> : <Workspace />}
        {children}
      </div>
    </ChatProvider>
  );
}
