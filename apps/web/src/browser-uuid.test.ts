import { describe, expect, it } from "vitest";
import { createBrowserUuidV4 } from "./browser-uuid";

describe("browser UUID compatibility", () => {
  it("uses the native implementation when available", () => {
    const native = () => "native-uuid";
    expect(createBrowserUuidV4({ randomUUID: native, getRandomValues: () => { throw new Error("should not run"); } } as unknown as Crypto)).toBe("native-uuid");
  });

  it("creates unique RFC 4122 v4 UUIDs with getRandomValues when randomUUID is unavailable", () => {
    let seed = 0;
    const cryptoWithoutRandomUuid = {
      getRandomValues: (bytes: Uint8Array) => {
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = (seed + index) & 0xff;
        seed += 17;
        return bytes;
      },
    } as unknown as Crypto;
    const first = createBrowserUuidV4(cryptoWithoutRandomUuid);
    const second = createBrowserUuidV4(cryptoWithoutRandomUuid);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).not.toBe(first);
  });

  it("fails explicitly instead of using insecure randomness", () => {
    expect(() => createBrowserUuidV4(null)).toThrow("浏览器过旧，无法安全生成请求标识");
  });
});
