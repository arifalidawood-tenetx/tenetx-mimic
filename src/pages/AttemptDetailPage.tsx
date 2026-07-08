import { useParams } from "react-router-dom";

/**
 * Placeholder — real attempt-detail content lands in todo 16.
 */
export function AttemptDetailPage() {
  const { ticket, feature, attempt } = useParams();

  return (
    <div className="p-6">
      <h2 className="text-lg font-semibold text-ink">Attempt Detail</h2>
      <p className="mt-2 text-sm text-ink-muted">
        TODO: implemented in todo 16. ticket={ticket} feature={feature} attempt=
        {attempt}
      </p>
    </div>
  );
}
