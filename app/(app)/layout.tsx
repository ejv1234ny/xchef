import { getAppContext } from "@/lib/db/context";
import { TabBar } from "@/components/tab-bar";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const ctx = await getAppContext();
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col">
      <header className="flex h-12 items-center justify-between px-4 text-sm text-neutral-500">
        <span className="font-semibold text-neutral-900">xchef</span>
        <span className="truncate">{ctx.location.name}</span>
      </header>
      <main className="flex-1 px-4 pb-24">{children}</main>
      <TabBar />
    </div>
  );
}
