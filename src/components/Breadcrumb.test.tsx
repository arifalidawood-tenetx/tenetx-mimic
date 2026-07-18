import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Breadcrumb } from "./Breadcrumb";

describe("Breadcrumb", () => {
  it("renders null when route does not match /mimic/:ticket/:feature/:attempt", () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/"]}>
        <Breadcrumb />
      </MemoryRouter>
    );

    expect(container.firstChild).toBeNull();
  });

  it("renders full breadcrumb trail when route matches /mimic/:ticket/:feature/:attempt", () => {
    render(
      <MemoryRouter initialEntries={["/mimic/TEN-135/saml-config/1"]}>
        <Breadcrumb />
      </MemoryRouter>
    );

    const dashboardLink = screen.getByRole("link", { name: "Dashboard" });
    expect(dashboardLink).toBeInTheDocument();
    expect(dashboardLink).toHaveAttribute("href", "/");

    expect(screen.getByText("TEN-135")).toBeInTheDocument();
    expect(screen.getByText("saml-config")).toBeInTheDocument();

    const attemptItem = screen.getByText("Attempt 1");
    expect(attemptItem).toBeInTheDocument();
    expect(attemptItem).toHaveAttribute("aria-current", "page");
    expect(attemptItem).toHaveClass("font-medium", "text-accent");
  });

  it("only the Dashboard segment is a link — ticket and feature are inert labels", () => {
    render(
      <MemoryRouter initialEntries={["/mimic/TEN-135/saml-config/1"]}>
        <Breadcrumb />
      </MemoryRouter>
    );

    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByText("TEN-135").tagName).toBe("SPAN");
    expect(screen.getByText("saml-config").tagName).toBe("SPAN");
  });

  it("renders with the chevron-trail nav shell and per-segment clip-path shapes", () => {
    render(
      <MemoryRouter initialEntries={["/mimic/TEN-135/saml-config/1"]}>
        <Breadcrumb />
      </MemoryRouter>
    );

    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(nav).toBeInTheDocument();
    expect(nav).toHaveClass("inline-flex", "overflow-hidden", "rounded-lg", "ring-1", "ring-line");

    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveClass("crumb-chevron-first");
    expect(screen.getByText("TEN-135")).toHaveClass("crumb-chevron", "pl-5");
    expect(screen.getByText("saml-config")).toHaveClass("crumb-chevron", "pl-5");
    expect(screen.getByText("Attempt 1")).toHaveClass("crumb-chevron-last", "pl-5");
  });
});
