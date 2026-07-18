import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DiffView } from "./DiffView";

// Real unified-diff sample drawn from
// .omo/evidence/task-9-keycloak-saml-login-diff-fix.txt (the prior plan's
// diff deliverable), trimmed to one hunk for a focused assertion set.
const SAMPLE_DIFF = `--- a/tenetx/api/routes/auth.py
+++ b/tenetx/api/routes/auth.py
@@ -40,4 +40,8 @@ def _public_origin_from_request(request: Request, *, default_host: str = "tenetx.dev") -> str:
 def _public_origin_from_request(request: Request, *, default_host: str = "tenetx.dev") -> str:
     proto = request.headers.get("x-forwarded-proto", request.url.scheme or "https")
-    host = request.headers.get("host", default_host)
+    host = _get_request_host(request) or request.headers.get("host", default_host)
     return public_origin_from_request_parts(host=host, proto=proto, default_host=default_host)`;

describe("DiffView", () => {
  it("renders a real sample diff with distinct classes for +, -, and @@ lines", () => {
    render(<DiffView diff={SAMPLE_DIFF} />);

    const addedLine = screen.getByText((content) =>
      content.startsWith("+") && content.includes("_get_request_host(request)")
    );
    expect(addedLine).toHaveClass("bg-success-soft", "text-success");

    const removedLine = screen.getByText(
      (content) => content.startsWith("-") && content.includes('host = request.headers.get')
    );
    expect(removedLine).toHaveClass("bg-danger-soft", "text-danger");

    const hunkHeader = screen.getByText((content) => content.startsWith("@@ -40,4 +40,8"));
    expect(hunkHeader).toHaveClass("bg-card-3", "text-ink-muted", "font-semibold");

    const fileHeader = screen.getByText((content) => content.startsWith("--- a/"));
    expect(fileHeader).not.toHaveClass("bg-success-soft");
    expect(fileHeader).not.toHaveClass("bg-danger-soft");
    expect(fileHeader).not.toHaveClass("bg-card-3");
  });

  it("keeps unchanged context lines in the default (unhighlighted) tone", () => {
    render(<DiffView diff={SAMPLE_DIFF} />);

    const contextLine = screen.getByText((content) =>
      content.includes("x-forwarded-proto")
    );
    expect(contextLine).toHaveClass("text-ink");
    expect(contextLine).not.toHaveClass("bg-success-soft");
    expect(contextLine).not.toHaveClass("bg-danger-soft");
  });

  it("renders one line per newline-separated input line, preserving empty lines", () => {
    const { container } = render(<DiffView diff={"+added\n\n-removed"} />);
    const lineDivs = container.firstChild?.childNodes;
    expect(lineDivs).toHaveLength(3);
  });
});
