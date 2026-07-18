import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { CommandPalette } from "./CommandPalette";

const navigateMock = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

beforeEach(() => {
  navigateMock.mockClear();
});

function renderPalette(onClose = vi.fn()) {
  render(
    <MemoryRouter>
      <CommandPalette open onClose={onClose} />
    </MemoryRouter>
  );
  return onClose;
}

describe("CommandPalette", () => {
  it("does not render anything when open is false", () => {
    render(
      <MemoryRouter>
        <CommandPalette open={false} onClose={vi.fn()} />
      </MemoryRouter>
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders the palette when open is true (Cmd+K simulated via prop)", () => {
    renderPalette();

    expect(screen.getByRole("dialog", { name: /command palette/i })).toBeInTheDocument();
    expect(screen.getByText("Navigate")).toBeInTheDocument();
    expect(screen.getByText("Actions")).toBeInTheDocument();
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
    expect(screen.getByText("Try it out")).toBeInTheDocument();
    expect(screen.getByText("MCP")).toBeInTheDocument();
    expect(screen.getByText("Generate MCP Token")).toBeInTheDocument();
  });

  it("typing a query filters both groups by substring match on the label", () => {
    renderPalette();

    const input = screen.getByPlaceholderText(/search/i);
    fireEvent.change(input, { target: { value: "dash" } });

    expect(screen.getByText("Dashboard")).toBeInTheDocument();
    expect(screen.queryByText("Try it out")).not.toBeInTheDocument();
    expect(screen.queryByText("MCP")).not.toBeInTheDocument();
    expect(screen.queryByText("Generate MCP Token")).not.toBeInTheDocument();
    expect(screen.queryByText("Actions")).not.toBeInTheDocument();
  });

  it("is case-insensitive", () => {
    renderPalette();

    const input = screen.getByPlaceholderText(/search/i);
    fireEvent.change(input, { target: { value: "MCP" } });

    expect(screen.getByText("MCP")).toBeInTheDocument();
    expect(screen.getByText("Generate MCP Token")).toBeInTheDocument();
  });

  it('typing a query matching nothing shows an explicit "No results" row', () => {
    renderPalette();

    const input = screen.getByPlaceholderText(/search/i);
    fireEvent.change(input, { target: { value: "zzzzz-no-match" } });

    expect(screen.getByText("No results")).toBeInTheDocument();
    expect(screen.queryByText("Dashboard")).not.toBeInTheDocument();
  });

  it("Enter on the highlighted (default first) item navigates and closes", () => {
    const onClose = vi.fn();
    renderPalette(onClose);

    fireEvent.keyDown(window, { key: "Enter" });

    expect(navigateMock).toHaveBeenCalledWith("/");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ArrowDown moves the highlight, then Enter navigates to the next item", () => {
    const onClose = vi.fn();
    renderPalette(onClose);

    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "Enter" });

    expect(navigateMock).toHaveBeenCalledWith("/mimic/try-it-out");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking the Generate MCP Token action navigates to /mcp?action=generate and closes", () => {
    const onClose = vi.fn();
    renderPalette(onClose);

    fireEvent.click(screen.getByText("Generate MCP Token"));

    expect(navigateMock).toHaveBeenCalledWith("/mcp?action=generate");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape closes without navigating", () => {
    const onClose = vi.fn();
    renderPalette(onClose);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("clicking the backdrop closes without navigating", () => {
    const onClose = vi.fn();
    renderPalette(onClose);

    fireEvent.click(screen.getByTestId("command-palette-backdrop"));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
