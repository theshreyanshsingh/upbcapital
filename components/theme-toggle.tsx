"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";

export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const dark = mounted && resolvedTheme === "dark";
  return (
    <button type="button" onClick={() => setTheme(dark ? "light" : "dark")} className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[13px] hover:bg-hover", className)}>
      {dark ? <Sun className="size-[15px] text-muted-foreground" /> : <Moon className="size-[15px] text-muted-foreground" />}
      {dark ? "Light mode" : "Dark mode"}
    </button>
  );
}
