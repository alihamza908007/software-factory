import { describe, it, expect } from "vitest";
import { isCrossSite, safeEqual, sameOrigin } from "@/lib/core/request-guard";

describe("request guard", () => {
  it("allows non-browser clients without an Origin header", () => {
    expect(sameOrigin(null, "127.0.0.1:3000")).toBe(true);
  });

  it("allows a same-origin browser request", () => {
    expect(sameOrigin("http://127.0.0.1:3000", "127.0.0.1:3000")).toBe(true);
    expect(sameOrigin("https://factory.local", "factory.local")).toBe(true);
  });

  it("rejects a different host or an opaque origin", () => {
    expect(sameOrigin("http://evil.example", "127.0.0.1:3000")).toBe(false);
    expect(sameOrigin("http://127.0.0.1:3001", "127.0.0.1:3000")).toBe(false);
    expect(sameOrigin("null", "127.0.0.1:3000")).toBe(false);
    expect(sameOrigin("not a url", "127.0.0.1:3000")).toBe(false);
  });

  it("detects cross-site fetch metadata", () => {
    expect(isCrossSite("cross-site")).toBe(true);
    expect(isCrossSite("same-origin")).toBe(false);
    expect(isCrossSite(null)).toBe(false);
  });

  it("compares tokens without matching prefixes", () => {
    expect(safeEqual("secret-token", "secret-token")).toBe(true);
    expect(safeEqual("secret-token", "secret-toke")).toBe(false);
    expect(safeEqual("secret-token", "secret-tokem")).toBe(false);
    expect(safeEqual("", "secret")).toBe(false);
  });
});
