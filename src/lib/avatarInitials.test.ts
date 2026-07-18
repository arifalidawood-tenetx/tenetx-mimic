import { describe, it, expect } from "vitest";
import { getInitials } from "./avatarInitials";

describe("getInitials", () => {
  it("returns a single initial for a normal email with no local-part separator", () => {
    expect(getInitials("jane@tenetx.ai")).toBe("J");
  });

  it("returns first+second initials for a dotted local-part email", () => {
    expect(getInitials("jane.doe@tenetx.ai")).toBe("JD");
  });

  it("returns first+second initials for an underscore-separated local-part email", () => {
    expect(getInitials("jane_doe@tenetx.ai")).toBe("JD");
  });

  it('returns "?" for an empty string', () => {
    expect(getInitials("")).toBe("?");
  });

  it('returns "?" for null', () => {
    expect(getInitials(null)).toBe("?");
  });

  it('returns "?" for undefined', () => {
    expect(getInitials(undefined)).toBe("?");
  });

  it("never throws and returns a 1-2 char uppercase result for non-email garbage", () => {
    const result = getInitials("not-an-email");
    expect(result).toBe("N");
    expect(result.length).toBeLessThanOrEqual(2);
    expect(result).toBe(result.toUpperCase());
  });

  it('returns "?" for a local part that is empty (e.g. "@domain.com")', () => {
    expect(getInitials("@tenetx.ai")).toBe("?");
  });

  it("falls back to a single initial when the separator is the last character", () => {
    expect(getInitials("jane.@tenetx.ai")).toBe("J");
  });
});
