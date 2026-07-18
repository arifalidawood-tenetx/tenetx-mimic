import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ToastProvider, useToast, type ToastType } from "./Toast";

function Harness({ type }: { type?: ToastType }) {
  const { addToast } = useToast();
  return (
    <button type="button" onClick={() => addToast("Hello from test", type)}>
      Fire toast
    </button>
  );
}

describe("ToastProvider / useToast", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a toast when addToast is called", () => {
    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: /fire toast/i }));

    expect(screen.getByText("Hello from test")).toBeInTheDocument();
  });

  it("auto-removes the toast after 4000ms (not before)", () => {
    vi.useFakeTimers();

    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>
    );

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /fire toast/i }));
    });

    expect(screen.getByText("Hello from test")).toBeInTheDocument();

    // Not yet dismissed just before the 4s mark.
    act(() => {
      vi.advanceTimersByTime(3999);
    });
    expect(screen.getByText("Hello from test")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText("Hello from test")).not.toBeInTheDocument();
  });

  it("times each toast individually rather than sharing one timer", () => {
    vi.useFakeTimers();

    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>
    );

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /fire toast/i }));
    });

    // Advance halfway, then fire a second toast — its own 4s clock starts now.
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /fire toast/i }));
    });

    expect(screen.getAllByText("Hello from test")).toHaveLength(2);

    // First toast's 4s elapses (2000 + 2000); second toast still has 2s left.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getAllByText("Hello from test")).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByText("Hello from test")).not.toBeInTheDocument();
  });

  it.each(["success", "info", "warning", "error"] as const)(
    "renders the %s toast type without crashing",
    (type) => {
      render(
        <ToastProvider>
          <Harness type={type} />
        </ToastProvider>
      );

      fireEvent.click(screen.getByRole("button", { name: /fire toast/i }));

      expect(screen.getByText("Hello from test")).toBeInTheDocument();
    }
  );

  it("handles an invalid/unknown toast type gracefully without crashing", () => {
    function InvalidHarness() {
      const { addToast } = useToast();
      return (
        <button
          type="button"
          onClick={() => addToast("Invalid type toast", "bogus" as ToastType)}
        >
          Fire invalid
        </button>
      );
    }

    render(
      <ToastProvider>
        <InvalidHarness />
      </ToastProvider>
    );

    expect(() => {
      fireEvent.click(screen.getByRole("button", { name: /fire invalid/i }));
    }).not.toThrow();

    expect(screen.getByText("Invalid type toast")).toBeInTheDocument();
  });

  it("dismiss button removes the toast immediately", () => {
    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: /fire toast/i }));
    expect(screen.getByText("Hello from test")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /dismiss notification/i }));
    expect(screen.queryByText("Hello from test")).not.toBeInTheDocument();
  });

  it("throws a helpful error when useToast is used outside ToastProvider", () => {
    function Broken() {
      useToast();
      return null;
    }

    // React logs the thrown render error to console; silence it for this
    // assertion only.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Broken />)).toThrow(
      /useToast must be used within a ToastProvider/
    );
    spy.mockRestore();
  });
});
