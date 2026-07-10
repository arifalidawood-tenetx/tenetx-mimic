import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Badge, SectionHeader } from "./ui";

describe("SectionHeader", () => {
  it("renders leading icon svg plus text when icon is set", () => {
    const { container } = render(<SectionHeader icon="grid">Dashboard</SectionHeader>);
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveClass("h-4", "w-4", "shrink-0", "text-ink-muted");
  });

  it("renders text only, no svg, when icon is omitted", () => {
    const { container } = render(<SectionHeader>Overview</SectionHeader>);
    expect(screen.getByText("Overview")).toBeInTheDocument();
    expect(container.querySelector("svg")).toBeNull();
  });

  it("does not crash on an unrecognized icon name and still renders text", () => {
    render(<SectionHeader icon="not-a-real-icon">Fallback</SectionHeader>);
    expect(screen.getByText("Fallback")).toBeInTheDocument();
  });

  it("applies the exact heading className contract", () => {
    render(<SectionHeader>Heading</SectionHeader>);
    const heading = screen.getByText("Heading");
    expect(heading.tagName).toBe("H2");
    expect(heading).toHaveClass("flex", "items-center", "gap-2", "text-lg", "font-semibold", "text-ink");
  });
});

describe("Badge", () => {
  it("renders with font-semibold weight", () => {
    render(<Badge>Active</Badge>);
    expect(screen.getByText("Active")).toHaveClass("font-semibold");
  });
});
