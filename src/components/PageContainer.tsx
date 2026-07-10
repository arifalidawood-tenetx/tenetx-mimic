import type { ReactNode } from "react";
import { cn } from "@/utils/cn";

/* ── PageContainer ──────────────────────────────────────────────────────── */
type PageContainerSize = "wide" | "narrow";

const SIZE_CLASSES: Record<PageContainerSize, string> = {
  wide: "max-w-6xl",
  narrow: "max-w-3xl",
};

export function PageContainer({
  size = "wide",
  className,
  children,
}: {
  size?: PageContainerSize;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "mx-auto w-full px-4 py-6 sm:px-6 sm:py-8 lg:px-8 lg:py-10",
        SIZE_CLASSES[size],
        className
      )}
    >
      {children}
    </div>
  );
}
