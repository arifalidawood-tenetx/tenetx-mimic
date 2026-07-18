import { useMatch } from "react-router-dom";
import { Link } from "react-router-dom";

export type Crumb = {
  label: string;
  href?: string;
};

function cn(...parts: Array<string | false | undefined>) {
  return parts.filter(Boolean).join(" ");
}

/**
 * Chevron-trail breadcrumb for the attempt detail page.
 * Renders only when the route matches "/mimic/:ticket/:feature/:attempt".
 * Returns null for all other routes (e.g. dashboard) — including the
 * sticky wrapper below, so routes without a breadcrumb get no leftover
 * bar under the Topbar.
 *
 * Sticky positioning: only the wrapper around the pill itself is sticky
 * (`w-fit`, transparent background) — NOT a full-width bar — so it stays
 * pinned at `top-14` (Topbar's own height, `z-20` below Topbar's `z-30`)
 * without visually occupying the entire row under the Topbar.
 *
 * Visual: overlapping chevron-shaped segments (clip-path, see
 * `.crumb-chevron` / `.crumb-chevron-first` / `.crumb-chevron-last` in
 * `src/index.css`) instead of a plain "/"-separated text trail. Only
 * "Dashboard" links anywhere real (`/`) — the ticket and feature segments
 * have no dedicated route to link to, so they render as inert labels
 * within the trail; the final "Attempt N" segment is the current page.
 */
export function Breadcrumb() {
  const match = useMatch("/mimic/:ticket/:feature/:attempt");

  if (!match) {
    return null;
  }

  const { ticket, feature, attempt } = match.params;

  const items: Crumb[] = [
    { label: "Dashboard", href: "/" },
    { label: ticket ?? "" },
    { label: feature ?? "" },
    { label: `Attempt ${attempt}` },
  ];

  return (
    <div className="sticky top-14 z-20 w-fit px-4 py-3 md:px-6">
      <nav
        aria-label="Breadcrumb"
        className="inline-flex overflow-hidden rounded-lg text-sm ring-1 ring-line"
      >
        {items.map((item, i) => {
          const last = i === items.length - 1;
          const first = i === 0;
          const shape = first
            ? "crumb-chevron-first"
            : last
              ? "crumb-chevron-last"
              : "crumb-chevron";

          if (last) {
            return (
              <span
                key={item.label}
                className={cn(
                  "bg-accent-soft px-4 py-2 font-medium text-accent",
                  !first && "pl-5",
                  shape,
                )}
                aria-current="page"
              >
                {item.label}
              </span>
            );
          }

          if (!item.href) {
            return (
              <span
                key={item.label}
                className={cn(
                  "bg-card px-4 py-2 text-ink-muted",
                  !first && "pl-5",
                  shape,
                )}
              >
                {item.label}
              </span>
            );
          }

          return (
            <Link
              key={item.label}
              to={item.href}
              className={cn(
                "bg-card px-4 py-2 text-ink-muted transition-colors hover:bg-card-3 hover:text-ink focus-ring",
                !first && "pl-5",
                shape,
              )}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
