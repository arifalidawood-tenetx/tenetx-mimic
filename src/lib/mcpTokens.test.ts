// @vitest-environment node
//
// Pinned to the `node` environment (the suite default is jsdom, see
// vitest.config.ts) because these are pure-module tests with no DOM, and jsdom
// v23 does not implement `crypto.subtle` — Node's Web Crypto does, so
// `sha256()`'s real digest path is exercised for free.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { addDoc, collection, doc, getDocs, updateDoc } from "firebase/firestore";
import {
  generatePatToken,
  sha256,
  createToken,
  listTokens,
  revokeToken,
  getMcpCounts,
} from "./mcpTokens";

// Same mocking convention as src/pages/SamlConfigPage.test.tsx: mock the
// firebaseClient `db` export to an inert object, and mock every firebase/firestore
// SDK call this module uses as a vi.fn(). `collection`/`doc` return string
// sentinels encoding their args so we can assert which collection/doc was hit.
vi.mock("@/lib/firebaseClient", () => ({ auth: {}, db: {} }));
vi.mock("firebase/firestore", () => ({
  addDoc: vi.fn(),
  collection: vi.fn((_db: unknown, name: string) => `COLLECTION:${name}`),
  doc: vi.fn((_db: unknown, name: string, id: string) => `DOC:${name}/${id}`),
  getDocs: vi.fn(),
  updateDoc: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("generatePatToken", () => {
  it("produces the ttx_pat_ prefix + 40 lowercase hex chars (48 total)", () => {
    const token = generatePatToken();
    expect(token).toMatch(/^ttx_pat_[0-9a-f]{40}$/);
    expect(token.startsWith("ttx_pat_")).toBe(true);
    expect(token).toHaveLength(48); // "ttx_pat_" (8) + 20 bytes * 2 hex chars (40)
  });

  it("produces a fresh (non-repeating) token each call", () => {
    const a = generatePatToken();
    const b = generatePatToken();
    expect(a).not.toBe(b);
  });
});

describe("sha256", () => {
  it("is deterministic: same input -> same hash", async () => {
    expect(await sha256("hello")).toBe(await sha256("hello"));
  });

  it("different inputs -> different hashes", async () => {
    expect(await sha256("hello")).not.toBe(await sha256("world"));
  });

  it("returns 64 lowercase hex chars", async () => {
    expect(await sha256("anything")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the canonical SHA-256 vector for \"abc\"", async () => {
    // Proves the real Web Crypto digest path runs (not a stub).
    expect(await sha256("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});

describe("createToken", () => {
  it("writes only the hash/prefix (never the plaintext) and returns the plaintext exactly once", async () => {
    vi.mocked(addDoc).mockResolvedValueOnce({ id: "newDocId" } as never);

    const { id, token } = await createToken({
      name: "CI runner",
      scopes: ["simenv:read", "diffs:read"],
      expiresInDays: 30,
    });

    // Returned plaintext is a real PAT, and the new doc id is threaded back.
    expect(id).toBe("newDocId");
    expect(token).toMatch(/^ttx_pat_[0-9a-f]{40}$/);

    expect(addDoc).toHaveBeenCalledTimes(1);
    expect(collection).toHaveBeenCalledWith(expect.anything(), "mcp_tokens");

    const [collectionRef, payload] = vi.mocked(addDoc).mock.calls[0];
    expect(collectionRef).toBe("COLLECTION:mcp_tokens");

    const written = payload as Record<string, unknown>;

    // SECURITY: the plaintext token must NOT appear anywhere in the written doc.
    expect(JSON.stringify(written)).not.toContain(token);
    expect(Object.values(written)).not.toContain(token);

    // What IS persisted: the hash of the plaintext + a 12-char display prefix.
    expect(written.tokenHash).toBe(await sha256(token));
    expect(written.tokenHash).not.toBe(token);
    expect(written.tokenPrefix).toBe(token.slice(0, 12));
    expect(written).toMatchObject({
      name: "CI runner",
      scopes: ["simenv:read", "diffs:read"],
      lastUsedAt: null,
      revoked: false,
    });
    // No raw plaintext field smuggled in under any name.
    expect(written).not.toHaveProperty("token");
    expect(written).not.toHaveProperty("plaintext");
  });

  it("stamps expiresAt at exactly createdAt + expiresInDays (ISO strings)", async () => {
    vi.mocked(addDoc).mockResolvedValueOnce({ id: "x" } as never);

    await createToken({ name: "n", scopes: [], expiresInDays: 7 });

    const written = vi.mocked(addDoc).mock.calls[0][1] as Record<string, unknown>;
    expect(written.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(written.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);

    const createdAt = new Date(written.createdAt as string).getTime();
    const expiresAt = new Date(written.expiresAt as string).getTime();
    // createToken derives both from a single `now`, so the delta is exact.
    expect(expiresAt - createdAt).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("listTokens", () => {
  it("maps Firestore docs to McpToken[], threading in the doc id", async () => {
    vi.mocked(getDocs).mockResolvedValueOnce({
      size: 2,
      docs: [
        {
          id: "tok1",
          data: () => ({
            name: "CI runner",
            tokenHash: "hash-1",
            tokenPrefix: "ttx_pat_aaaa",
            scopes: ["simenv:read"],
            expiresAt: "2027-01-01T00:00:00.000Z",
            lastUsedAt: null,
            revoked: false,
            createdAt: "2026-01-01T00:00:00.000Z",
          }),
        },
        {
          id: "tok2",
          data: () => ({
            name: "Local dev",
            tokenHash: "hash-2",
            tokenPrefix: "ttx_pat_bbbb",
            scopes: ["diffs:read", "guard:read"],
            expiresAt: "2027-06-01T00:00:00.000Z",
            lastUsedAt: "2026-05-01T00:00:00.000Z",
            revoked: true,
            createdAt: "2026-02-01T00:00:00.000Z",
          }),
        },
      ],
    } as never);

    const tokens = await listTokens();

    expect(collection).toHaveBeenCalledWith(expect.anything(), "mcp_tokens");
    expect(tokens).toEqual([
      {
        id: "tok1",
        name: "CI runner",
        tokenHash: "hash-1",
        tokenPrefix: "ttx_pat_aaaa",
        scopes: ["simenv:read"],
        expiresAt: "2027-01-01T00:00:00.000Z",
        lastUsedAt: null,
        revoked: false,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "tok2",
        name: "Local dev",
        tokenHash: "hash-2",
        tokenPrefix: "ttx_pat_bbbb",
        scopes: ["diffs:read", "guard:read"],
        expiresAt: "2027-06-01T00:00:00.000Z",
        lastUsedAt: "2026-05-01T00:00:00.000Z",
        revoked: true,
        createdAt: "2026-02-01T00:00:00.000Z",
      },
    ]);
  });

  it("returns [] when the collection is empty", async () => {
    vi.mocked(getDocs).mockResolvedValueOnce({ size: 0, docs: [] } as never);
    expect(await listTokens()).toEqual([]);
  });
});

describe("revokeToken", () => {
  it("sets revoked:true on the doc and never deletes it", async () => {
    vi.mocked(updateDoc).mockResolvedValueOnce(undefined as never);

    await revokeToken("tok1");

    expect(doc).toHaveBeenCalledWith(expect.anything(), "mcp_tokens", "tok1");
    expect(updateDoc).toHaveBeenCalledTimes(1);

    const [docRef, patch] = vi.mocked(updateDoc).mock.calls[0];
    expect(docRef).toBe("DOC:mcp_tokens/tok1");
    expect(patch).toEqual({ revoked: true });
    // The only mutation is the revoked flag — no delete API is even imported.
    expect(patch).not.toHaveProperty("__delete__");
  });

  it("rejects (does not silently succeed) when the doc does not exist", async () => {
    vi.mocked(updateDoc).mockRejectedValueOnce(
      Object.assign(new Error("No document to update: mcp_tokens/missing"), {
        code: "not-found",
      })
    );

    await expect(revokeToken("missing")).rejects.toThrow("No document to update");
  });
});

describe("getMcpCounts", () => {
  it("returns the doc counts for mcp_tokens and mcp_tool_calls", async () => {
    // Route each getDocs call by the collection sentinel so the result is
    // independent of Promise.all resolution order.
    vi.mocked(getDocs).mockImplementation(async (ref: unknown) => {
      if (ref === "COLLECTION:mcp_tokens") return { size: 3, docs: [] } as never;
      if (ref === "COLLECTION:mcp_tool_calls") return { size: 12, docs: [] } as never;
      throw new Error(`unexpected collection ref: ${String(ref)}`);
    });

    expect(await getMcpCounts()).toEqual({ tokenCount: 3, toolCallCount: 12 });

    expect(collection).toHaveBeenCalledWith(expect.anything(), "mcp_tokens");
    expect(collection).toHaveBeenCalledWith(expect.anything(), "mcp_tool_calls");
  });

  it("reports zero counts for empty collections", async () => {
    vi.mocked(getDocs).mockResolvedValue({ size: 0, docs: [] } as never);
    expect(await getMcpCounts()).toEqual({ tokenCount: 0, toolCallCount: 0 });
  });
});
