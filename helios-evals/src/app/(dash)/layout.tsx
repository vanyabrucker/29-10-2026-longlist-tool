import { cookies } from "next/headers";
import { Sidebar } from "@/components/Sidebar";
import { GATEWAY_URL, SESSION_COOKIE, gatewayHeaders, requireDev } from "@/lib/gatewayServer";

async function todoCount(): Promise<number | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const r = await fetch(`${GATEWAY_URL}/feedback?status=todo`, {
    headers: gatewayHeaders(token),
    cache: "no-store",
  });
  return r.ok ? ((await r.json()).items as unknown[]).length : null;
}

export default async function DashLayout({ children }: { children: React.ReactNode }) {
  const me = await requireDev();
  return (
    <div className="flex h-full">
      <Sidebar name={me.name} todo={await todoCount()} />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1180px] px-8 py-8">{children}</div>
      </main>
    </div>
  );
}
