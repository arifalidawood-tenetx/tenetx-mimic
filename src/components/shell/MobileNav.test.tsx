import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { MobileNav } from "./MobileNav";
import { ToastProvider } from "./Toast";

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location-probe">{location.pathname}</span>;
}

function renderNav(initialEntry: string) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <ToastProvider>
        <MobileNav />
        <LocationProbe />
      </ToastProvider>
    </MemoryRouter>
  );
}

describe("MobileNav", () => {
  it("renders all 4 items", () => {
    renderNav("/");

    expect(screen.getByRole("link", { name: /dashboard/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /try it out/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /mcp/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /preferences/i })).toBeInTheDocument();
  });

  it("highlights Dashboard when at /", () => {
    renderNav("/");

    expect(screen.getByRole("link", { name: /dashboard/i })).toHaveClass("text-accent");
    expect(screen.getByRole("link", { name: /try it out/i })).not.toHaveClass("text-accent");
    expect(screen.getByRole("link", { name: /mcp/i })).not.toHaveClass("text-accent");
  });

  it("highlights Try it out when at /mimic/try-it-out", () => {
    renderNav("/mimic/try-it-out");

    expect(screen.getByRole("link", { name: /try it out/i })).toHaveClass("text-accent");
    expect(screen.getByRole("link", { name: /dashboard/i })).not.toHaveClass("text-accent");
    expect(screen.getByRole("link", { name: /mcp/i })).not.toHaveClass("text-accent");
  });

  it("highlights MCP when at /mcp", () => {
    renderNav("/mcp");

    expect(screen.getByRole("link", { name: /mcp/i })).toHaveClass("text-accent");
    expect(screen.getByRole("link", { name: /dashboard/i })).not.toHaveClass("text-accent");
    expect(screen.getByRole("link", { name: /try it out/i })).not.toHaveClass("text-accent");
  });

  it("highlights nothing on a route matching none of the 3 real paths (e.g. ticket-detail route)", () => {
    renderNav("/mimic/TENQA-17/x/1");

    expect(screen.getByRole("link", { name: /dashboard/i })).not.toHaveClass("text-accent");
    expect(screen.getByRole("link", { name: /try it out/i })).not.toHaveClass("text-accent");
    expect(screen.getByRole("link", { name: /mcp/i })).not.toHaveClass("text-accent");
  });

  it("Preferences click fires addToast('Settings coming soon', 'info') and does not navigate", () => {
    renderNav("/mimic/try-it-out");

    fireEvent.click(screen.getByRole("button", { name: /preferences/i }));

    expect(screen.getByText("Settings coming soon")).toBeInTheDocument();
    expect(screen.getByTestId("location-probe")).toHaveTextContent("/mimic/try-it-out");
  });
});
