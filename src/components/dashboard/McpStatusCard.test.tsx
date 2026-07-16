import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { McpStatusCard } from "./McpStatusCard";

function renderCard(props: Parameters<typeof McpStatusCard>[0]) {
  return render(
    <MemoryRouter>
      <McpStatusCard {...props} />
    </MemoryRouter>
  );
}

describe("McpStatusCard", () => {
  it("renders 'Not yet deployed' plus real token/call counts, with no fabricated uptime/latency", () => {
    renderCard({ tokenCount: 3, toolCallCount: 12, deployed: false });

    expect(screen.getByText("Not yet deployed")).toBeInTheDocument();
    expect(screen.getByText("3 tokens issued")).toBeInTheDocument();
    expect(screen.getByText("12 calls logged")).toBeInTheDocument();

    // Honest-state guarantee: no uptime/latency rendered when not deployed,
    // even though this test doesn't pass those props at all.
    expect(screen.queryByText(/uptime/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/latency/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Deployed")).not.toBeInTheDocument();
  });

  it("renders '0 tokens issued' / '0 calls logged' for zero counts (not hidden, not a spinner)", () => {
    renderCard({ tokenCount: 0, toolCallCount: 0, deployed: false });

    expect(screen.getByText("0 tokens issued")).toBeInTheDocument();
    expect(screen.getByText("0 calls logged")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("renders explicit mock uptimePct/latencyMs when deployed is true (forward-compatible contract, not real data today)", () => {
    renderCard({
      tokenCount: 5,
      toolCallCount: 40,
      deployed: true,
      uptimePct: 99,
      latencyMs: 10,
    });

    expect(screen.getByText("Deployed")).toBeInTheDocument();
    expect(screen.getByText("99% uptime")).toBeInTheDocument();
    expect(screen.getByText("10ms latency")).toBeInTheDocument();
    expect(screen.getByText("5 tokens issued")).toBeInTheDocument();
    expect(screen.getByText("40 calls logged")).toBeInTheDocument();
    expect(screen.queryByText("Not yet deployed")).not.toBeInTheDocument();
  });

  it("does not render uptime/latency when deployed is true but the optional props are omitted", () => {
    renderCard({ tokenCount: 1, toolCallCount: 2, deployed: true });

    expect(screen.getByText("Deployed")).toBeInTheDocument();
    expect(screen.queryByText(/uptime/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/latency/i)).not.toBeInTheDocument();
  });

  it("renders a 'Manage tokens' link pointing to /mcp", () => {
    renderCard({ tokenCount: 3, toolCallCount: 12, deployed: false });

    const link = screen.getByRole("link", { name: "Manage tokens" });
    expect(link).toHaveAttribute("href", "/mcp");
  });
});
