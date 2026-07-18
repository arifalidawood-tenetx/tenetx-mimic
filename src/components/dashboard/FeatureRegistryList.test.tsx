import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { FeatureRegistryList } from "./FeatureRegistryList";
import type { DashboardFeatureSummary } from "@/lib/types";

function makeFeature(overrides: Partial<DashboardFeatureSummary> = {}): DashboardFeatureSummary {
  return {
    id: "f1",
    ticketId: "TEN-1",
    title: "Feature One",
    status: "planned",
    routePath: "/mimic/TEN-1/saml-login-fix/1",
    ...overrides,
  };
}

function renderList(features: DashboardFeatureSummary[]) {
  return render(
    <MemoryRouter>
      <FeatureRegistryList features={features} />
    </MemoryRouter>
  );
}

describe("FeatureRegistryList", () => {
  it("renders the empty state matching DashboardPage's existing message when there are 0 features", () => {
    renderList([]);

    expect(screen.getByText("No features tracked yet.")).toBeInTheDocument();
    expect(
      screen.getByText((_, element) => element?.textContent === "Seed a doc in mimic_features to see it here.")
    ).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("renders a single feature row: title, Jira link, status badge, and View attempt link", () => {
    renderList([
      makeFeature({
        id: "f1",
        ticketId: "TEN-1",
        title: "SAML login fix",
        status: "in-progress",
        routePath: "/mimic/TEN-1/saml-login-fix/1",
      }),
    ]);

    expect(screen.getByText("SAML login fix")).toBeInTheDocument();
    expect(screen.getByText("In progress")).toBeInTheDocument();

    const jiraLink = screen.getByRole("link", { name: "TEN-1" });
    expect(jiraLink).toHaveAttribute("href", "https://daxnai.atlassian.net/browse/TEN-1");
    expect(jiraLink).toHaveAttribute("target", "_blank");
    expect(jiraLink).toHaveAttribute("rel", "noreferrer");

    const viewAttemptLink = screen.getByRole("link", { name: "View attempt" });
    expect(viewAttemptLink).toHaveAttribute("href", "/mimic/TEN-1/saml-login-fix/1");
  });

  it("renders many features, each with its own row, Jira link, badge, and correct View attempt href", () => {
    renderList([
      makeFeature({
        id: "f1",
        ticketId: "TEN-1",
        title: "SAML login fix",
        status: "planned",
        routePath: "/mimic/TEN-1/saml-login-fix/1",
      }),
      makeFeature({
        id: "f2",
        ticketId: "TEN-2",
        title: "OIDC token refresh",
        status: "in-progress",
        routePath: "/mimic/TEN-2/oidc-refresh/1",
      }),
      makeFeature({
        id: "f3",
        ticketId: "TEN-3",
        title: "Keycloak group sync",
        status: "done",
        routePath: "/mimic/TEN-3/keycloak-sync/2",
      }),
    ]);

    expect(screen.getByText("SAML login fix")).toBeInTheDocument();
    expect(screen.getByText("OIDC token refresh")).toBeInTheDocument();
    expect(screen.getByText("Keycloak group sync")).toBeInTheDocument();

    expect(screen.getByText("Planned")).toBeInTheDocument();
    expect(screen.getByText("In progress")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();

    const jiraLinks = [
      screen.getByRole("link", { name: "TEN-1" }),
      screen.getByRole("link", { name: "TEN-2" }),
      screen.getByRole("link", { name: "TEN-3" }),
    ];
    expect(jiraLinks[0]).toHaveAttribute("href", "https://daxnai.atlassian.net/browse/TEN-1");
    expect(jiraLinks[1]).toHaveAttribute("href", "https://daxnai.atlassian.net/browse/TEN-2");
    expect(jiraLinks[2]).toHaveAttribute("href", "https://daxnai.atlassian.net/browse/TEN-3");

    const viewAttemptLinks = screen.getAllByRole("link", { name: "View attempt" });
    expect(viewAttemptLinks).toHaveLength(3);
    expect(viewAttemptLinks[0]).toHaveAttribute("href", "/mimic/TEN-1/saml-login-fix/1");
    expect(viewAttemptLinks[1]).toHaveAttribute("href", "/mimic/TEN-2/oidc-refresh/1");
    expect(viewAttemptLinks[2]).toHaveAttribute("href", "/mimic/TEN-3/keycloak-sync/2");
  });

  it("does not fabricate a relative-time column anywhere in the row", () => {
    renderList([makeFeature()]);

    expect(screen.queryByText(/ago$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/just now/i)).not.toBeInTheDocument();
  });

  it("renders a row with an empty routePath without crashing, falling back to '/'", () => {
    renderList([makeFeature({ id: "f-empty", ticketId: "TEN-9", title: "Blank route", routePath: "" })]);

    expect(screen.getByText("Blank route")).toBeInTheDocument();
    const viewAttemptLink = screen.getByRole("link", { name: "View attempt" });
    expect(viewAttemptLink).toHaveAttribute("href", "/");
  });

  it("renders a row with a missing (undefined) routePath without crashing, falling back to '/'", () => {
    const malformed = makeFeature({
      id: "f-missing",
      ticketId: "TEN-10",
      title: "Missing route",
    });
    // Simulate a malformed Firestore doc that bypasses compile-time guarantees.
    (malformed as unknown as { routePath: unknown }).routePath = undefined;

    expect(() => renderList([malformed])).not.toThrow();

    expect(screen.getByText("Missing route")).toBeInTheDocument();
    const viewAttemptLink = screen.getByRole("link", { name: "View attempt" });
    expect(viewAttemptLink).toHaveAttribute("href", "/");
  });
});
