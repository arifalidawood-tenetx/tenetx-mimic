import { useMatch } from "react-router-dom";
import { Link } from "react-router-dom";

/**
 * Breadcrumb navigation for the attempt detail page.
 * Renders only when the route matches "/mimic/:ticket/:feature/:attempt".
 * Returns null for all other routes (e.g. dashboard).
 */
export function Breadcrumb() {
  const match = useMatch("/mimic/:ticket/:feature/:attempt");

  if (!match) {
    return null;
  }

  const { ticket, feature, attempt } = match.params;

  return (
    <nav aria-label="Breadcrumb" className="px-4 pb-2 sm:px-6 lg:px-8">
      <ol className="flex items-center gap-1.5 text-xs text-ink-muted">
        <li>
          <Link
            to="/"
            className="hover:text-ink hover:underline focus-ring rounded"
          >
            Dashboard
          </Link>
        </li>
        <li aria-hidden="true">/</li>
        <li>{ticket}</li>
        <li aria-hidden="true">/</li>
        <li>{feature}</li>
        <li aria-hidden="true">/</li>
        <li aria-current="page" className="font-medium text-ink">
          Attempt {attempt}
        </li>
      </ol>
    </nav>
  );
}
