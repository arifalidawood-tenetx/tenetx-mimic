import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PageContainer } from "./PageContainer";

describe("PageContainer", () => {
  it("applies max-w-6xl for size='wide'", () => {
    const { container } = render(
      <PageContainer size="wide">
        <span>content</span>
      </PageContainer>
    );

    expect(container.firstChild).toHaveClass("max-w-6xl");
  });

  it("applies max-w-3xl for size='narrow'", () => {
    const { container } = render(
      <PageContainer size="narrow">
        <span>content</span>
      </PageContainer>
    );

    expect(container.firstChild).toHaveClass("max-w-3xl");
  });

  it("defaults to wide (max-w-6xl) when size prop is omitted", () => {
    const { container } = render(
      <PageContainer>
        <span>content</span>
      </PageContainer>
    );

    expect(container.firstChild).toHaveClass("max-w-6xl");
    expect(container.firstChild).not.toHaveClass("max-w-3xl");
  });

  it("merges className alongside width and layout classes", () => {
    const { container } = render(
      <PageContainer size="wide" className="custom-class">
        <span>content</span>
      </PageContainer>
    );

    expect(container.firstChild).toHaveClass("custom-class");
    expect(container.firstChild).toHaveClass("max-w-6xl");
    expect(container.firstChild).toHaveClass("mx-auto", "w-full");
  });

  it("renders children", () => {
    render(
      <PageContainer>
        <span>hello world</span>
      </PageContainer>
    );

    expect(screen.getByText("hello world")).toBeInTheDocument();
  });
});
