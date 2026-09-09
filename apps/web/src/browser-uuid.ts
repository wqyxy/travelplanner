type BrowserCrypto = Pick<Crypto, "getRandomValues"> & { randomUUID?: () => string };

const uuidUnavailableMessage = "浏览器过旧，无法安全生成请求标识。请升级浏览器后重试。";

export function createBrowserUuidV4(source: BrowserCrypto | null | undefined = globalThis.crypto): string {
  if (typeof source?.randomUUID === "function") return source.randomUUID();
  if (typeof source?.getRandomValues !== "function") throw new Error(uuidUnavailableMessage);

  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
