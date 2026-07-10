import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/utils/cn";
import { Icon, type IconName } from "./icons";

/* ── Button ─────────────────────────────────────────────────────────────── */
type ButtonVariant = "primary" | "subtle" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-on-accent hover:brightness-110 shadow-sm",
  subtle: "bg-card-2 text-ink ring-1 ring-line hover:bg-card-3",
  ghost: "text-ink-muted hover:text-ink hover:bg-card-2",
  danger: "bg-danger text-white hover:brightness-110 shadow-sm",
};
const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-9 gap-1.5 px-3 text-xs",
  md: "h-10 gap-2 px-3.5 text-sm",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
}

export function Button({
  variant = "subtle",
  size = "md",
  icon,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={cn(
        "focus-ring inline-flex items-center justify-center rounded-lg font-medium transition active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50",
        BUTTON_SIZES[size],
        BUTTON_VARIANTS[variant],
        className
      )}
      {...rest}
    >
      {icon && <Icon name={icon} className="h-4 w-4 shrink-0" />}
      {children}
    </button>
  );
}

/* ── IconButton (44px touch target) ─────────────────────────────────────── */
export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
}

export function IconButton({
  label,
  active,
  className,
  children,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        "focus-ring inline-flex h-11 w-11 items-center justify-center rounded-lg text-ink-muted transition hover:bg-card-2 hover:text-ink",
        active && "bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent",
        className
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/* ── Badge / Chip ───────────────────────────────────────────────────────── */
export type Tone = "neutral" | "success" | "warning" | "danger" | "accent";

const TONE_CLASSES: Record<Tone, string> = {
  neutral: "bg-card-3 text-ink-muted ring-1 ring-line",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  accent: "bg-accent-soft text-accent",
};

export function Badge({
  tone = "neutral",
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold leading-none",
        TONE_CLASSES[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

/* ── SectionHeader ──────────────────────────────────────────────────────── */
export function SectionHeader({
  icon,
  children,
  className,
}: {
  icon?: IconName;
  children: ReactNode;
  className?: string;
}) {
  return (
    <h2 className={cn("flex items-center gap-2 text-lg font-semibold text-ink", className)}>
      {icon && <Icon name={icon} className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />}
      {children}
    </h2>
  );
}

const DOT_TONE: Record<Tone, string> = {
  neutral: "bg-ink-faint",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  accent: "bg-accent",
};

export function SeverityDot({ tone }: { tone: Tone }) {
  return (
    <span
      className={cn("inline-block h-2 w-2 shrink-0 rounded-full", DOT_TONE[tone])}
      aria-hidden="true"
    />
  );
}

/* ── Skeleton / Spinner ─────────────────────────────────────────────────── */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-card-3", className)} />;
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn("animate-spin", className)}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ── Segmented control (≥40px options) ──────────────────────────────────── */
export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  size = "md",
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  size?: "sm" | "md";
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex items-center gap-0.5 rounded-lg bg-card-3 p-0.5 ring-1 ring-line"
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            className={cn(
              "focus-ring inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-md px-2.5 font-medium transition",
              size === "sm" ? "text-[11px]" : "text-xs",
              active ? "bg-card text-ink shadow-sm" : "text-ink-muted hover:text-ink"
            )}
          >
            {o.icon && <Icon name={o.icon} className="h-3.5 w-3.5" />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ── Tooltip (hover/focus, reduced-motion safe via CSS transition) ───────── */
export function Tooltip({
  label,
  children,
  side = "top",
}: {
  label: string;
  children: ReactNode;
  side?: "top" | "bottom";
}) {
  return (
    <span className="group/tt relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-md bg-overlay px-2 py-1 text-[11px] font-medium text-ink opacity-0 shadow-md ring-1 ring-line transition-opacity duration-150 group-hover/tt:opacity-100 group-focus-within/tt:opacity-100",
          side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5"
        )}
      >
        {label}
      </span>
    </span>
  );
}
