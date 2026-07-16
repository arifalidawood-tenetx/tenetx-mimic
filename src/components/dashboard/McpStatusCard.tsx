import { Link } from "react-router-dom";
import { Icon } from "@/components/icons";
import { Badge } from "@/components/ui";

export interface McpStatusCardProps {
  tokenCount: number;
  toolCallCount: number;
  deployed: boolean;
  /**
   * Optional, forward-compatible only. No route in this app produces real
   * uptime data today — a future plan that builds the real `/api/mcp`
   * JSON-RPC endpoint would pass this. Never fabricated by this component.
   */
  uptimePct?: number;
  /**
   * Optional, forward-compatible only. Same caveat as `uptimePct` — this
   * component never invents a value; it only renders what it's given.
   */
  latencyMs?: number;
}

/**
 * Dashboard summary card for the MCP (Model Context Protocol) integration.
 *
 * Honest-state design: when `deployed` is false (the only state this app
 * currently ever passes), it renders a "Not yet deployed" badge and the real
 * token/call counts it was given — never fabricated uptime/latency numbers.
 * The `uptimePct`/`latencyMs` props exist purely as a forward-compatible
 * contract for a future plan; this component itself has no opinion on
 * whether they're "real" or "stubbed" — it just renders whatever it receives.
 */
export function McpStatusCard({
  tokenCount,
  toolCallCount,
  deployed,
  uptimePct,
  latencyMs,
}: McpStatusCardProps) {
  const showLiveMetrics = deployed && uptimePct !== undefined && latencyMs !== undefined;

  return (
    <div className="rounded-xl bg-card-2 p-4 ring-1 ring-line shadow-sm hover:shadow-md transition-shadow">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon name="pulse" className="h-4 w-4 shrink-0 text-ink-muted" />
          <h2 className="text-sm font-semibold text-ink">MCP</h2>
        </div>
        {deployed ? (
          <Badge tone="success">Deployed</Badge>
        ) : (
          <Badge tone="neutral">Not yet deployed</Badge>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-ink-faint">Access tokens</p>
          <p className="mt-0.5 text-sm font-semibold tabular-nums text-ink">
            {tokenCount} tokens issued
          </p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider text-ink-faint">Activity</p>
          <p className="mt-0.5 text-sm font-semibold tabular-nums text-ink">
            {toolCallCount} calls logged
          </p>
        </div>

        {showLiveMetrics && (
          <>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-ink-faint">Uptime</p>
              <p className="mt-0.5 text-sm font-semibold tabular-nums text-success">
                {uptimePct}% uptime
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-ink-faint">Latency</p>
              <p className="mt-0.5 text-sm font-semibold tabular-nums text-ink">
                {latencyMs}ms latency
              </p>
            </div>
          </>
        )}
      </div>

      <Link
        to="/mcp"
        className="focus-ring mt-3 block text-center text-xs font-medium text-accent hover:underline"
      >
        Manage tokens
      </Link>
    </div>
  );
}
