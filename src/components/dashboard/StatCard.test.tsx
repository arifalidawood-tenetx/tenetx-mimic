import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  StatCard,
  computeCompletionRate,
  formatCompletionRate,
} from "./StatCard";
import type { DashboardFeatureSummary } from "@/lib/types";

function makeFeature(
  id: string,
  status: DashboardFeatureSummary["status"]
): DashboardFeatureSummary {
  return {
    id,
    ticketId: "TEN-1",
    title: `Feature ${id}`,
    status,
    routePath: "/",
  };
}

describe("StatCard", () => {
  it("renders label, value, and subtitle", () => {
    render(
      <StatCard
        label="Completion rate"
        value="42%"
        subtitle="Last batch · 10 features"
      />
    );

    expect(screen.getByText("Completion rate")).toBeInTheDocument();
    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(screen.getByText("Last batch · 10 features")).toBeInTheDocument();
  });

  it("renders children (e.g. a composed progress bar)", () => {
    render(
      <StatCard label="Completion rate" value="60%">
        <div data-testid="progress-bar" style={{ width: "60%" }} />
      </StatCard>
    );

    expect(screen.getByTestId("progress-bar")).toBeInTheDocument();
  });

  it("never mislabels the metric as a pass rate", () => {
    render(<StatCard label="Completion rate" value="100%" />);

    expect(screen.getByText("Completion rate")).toBeInTheDocument();
    expect(screen.queryByText(/pass rate/i)).not.toBeInTheDocument();
  });
});

describe("computeCompletionRate", () => {
  it("returns null for 0 total features (no NaN, no divide-by-zero)", () => {
    expect(computeCompletionRate([])).toBeNull();
  });

  it("computes 100 for a single done feature", () => {
    const features = [makeFeature("1", "done")];
    expect(computeCompletionRate(features)).toBe(100);
  });

  it("computes 0 for a single non-done feature", () => {
    const features = [makeFeature("1", "planned")];
    expect(computeCompletionRate(features)).toBe(0);
  });

  it("computes the rounded percentage for a mixed set (some done, some not)", () => {
    const features = [
      makeFeature("1", "done"),
      makeFeature("2", "done"),
      makeFeature("3", "in-progress"),
      makeFeature("4", "planned"),
      makeFeature("5", "planned"),
    ];
    // 2 done / 5 total = 40%
    expect(computeCompletionRate(features)).toBe(40);
  });

  it("rounds to 1 decimal place for non-clean divisions", () => {
    const features = [
      makeFeature("1", "done"),
      makeFeature("2", "in-progress"),
      makeFeature("3", "planned"),
    ];
    // 1 / 3 = 33.333...% -> rounded to 1 decimal = 33.3
    expect(computeCompletionRate(features)).toBe(33.3);
  });
});

describe("formatCompletionRate", () => {
  it("renders explicit 'No data yet' for a null rate (0 total features)", () => {
    expect(formatCompletionRate(null)).toBe("No data yet");
  });

  it("suffixes a numeric rate with %", () => {
    expect(formatCompletionRate(40)).toBe("40%");
    expect(formatCompletionRate(33.3)).toBe("33.3%");
  });

  it("integrates with StatCard to show 'No data yet' instead of NaN%", () => {
    const rate = computeCompletionRate([]);
    render(<StatCard label="Completion rate" value={formatCompletionRate(rate)} />);

    expect(screen.getByText("No data yet")).toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
  });
});
