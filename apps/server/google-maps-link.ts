import type { MapCandidate } from "./map-service.js";

export type GoogleMapsLinkPreview = {
  name: string | null;
  latitude: number;
  longitude: number;
  address: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  countryCode: string | null;
  warning: string | null;
};

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;
type Maps = { reverse(latitude: number, longitude: number, signal?: AbortSignal): Promise<MapCandidate | null> };

const MAX_URL_LENGTH = 2048;
const MAX_REDIRECTS = 5;
const GOOGLE_HOSTS = new Set(["google.com", "www.google.com", "maps.google.com", "maps.app.goo.gl", "goo.gl"]);

function allowed(url: URL) { return url.protocol === "https:" && !url.username && !url.password && GOOGLE_HOSTS.has(url.hostname.toLowerCase()); }
function coordinates(value: string | null | undefined): { latitude: number; longitude: number } | null {
  if (!value) return null;
  const match = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(value);
  if (!match) return null;
  const latitude = Number(match[1]); const longitude = Number(match[2]);
  return Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? { latitude, longitude } : null;
}
function pairFromData(value: string) {
  const match = /!3d(-?\d{1,2}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/.exec(value);
  return match ? coordinates(`${match[1]},${match[2]}`) : null;
}
function pairFromAt(value: string) {
  const match = /@(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/.exec(value);
  return match ? coordinates(`${match[1]},${match[2]}`) : null;
}
function placeName(url: URL) {
  const query = url.searchParams.get("query") ?? url.searchParams.get("q");
  if (query && !coordinates(query)) return query.trim().slice(0, 300) || null;
  const match = /\/maps\/place\/([^/@?]+)/u.exec(decodeURIComponent(url.pathname));
  return match ? match[1].replace(/\+/gu, " ").trim().slice(0, 300) || null : null;
}

/** Parses only user-supplied Google Maps URLs; it never fetches a Maps page body. */
export class GoogleMapsLinkService {
  constructor(private readonly maps: Maps, private readonly fetcher: Fetcher = (input, init) => fetch(input, init)) {}

  private async expand(raw: string) {
    if (raw.length > MAX_URL_LENGTH) throw new Error("Google Maps 链接不能超过 2048 个字符。");
    let current: URL;
    try { current = new URL(raw.trim()); } catch { throw new Error("请输入有效的 Google Maps HTTPS 链接。"); }
    if (!allowed(current)) throw new Error("只支持 Google Maps 的 HTTPS 分享链接。");
    for (let count = 0; ; count += 1) {
      if (!((current.hostname === "maps.app.goo.gl") || (current.hostname === "goo.gl"))) return current;
      if (count >= MAX_REDIRECTS) throw new Error("Google Maps 短链跳转次数过多。");
      const response = await this.fetcher(current, { method: "GET", redirect: "manual", headers: { Accept: "text/plain" }, signal: AbortSignal.timeout(5_000) });
      try {
        if (response.status < 300 || response.status >= 400) throw new Error("Google Maps 短链未能跳转到地点链接。");
        const location = response.headers.get("location");
        if (!location) throw new Error("Google Maps 短链未返回目标链接。");
        current = new URL(location, current);
        if (current.toString().length > MAX_URL_LENGTH || !allowed(current)) throw new Error("Google Maps 短链跳转到了不受支持的地址。");
      } finally { await response.body?.cancel(); }
    }
  }

  async preview(raw: string): Promise<GoogleMapsLinkPreview> {
    const url = await this.expand(raw);
    if (url.pathname.includes("/maps/dir/")) throw new Error("路线链接包含多个地点，请粘贴单个地点的 Google Maps 分享链接。");
    const encoded = url.toString();
    const coordinate = pairFromData(encoded)
      ?? coordinates(url.searchParams.get("query"))
      ?? coordinates(url.searchParams.get("q"))
      ?? coordinates(url.searchParams.get("ll"))
      ?? pairFromAt(encoded);
    if (!coordinate) throw new Error("该 Google Maps 链接未包含可确认的地点坐标，请从单个地点的“分享”重新复制链接。");
    const reverse = await this.maps.reverse(coordinate.latitude, coordinate.longitude).catch(() => null);
    return {
      name: placeName(url) ?? reverse?.name ?? null,
      latitude: coordinate.latitude,
      longitude: coordinate.longitude,
      address: reverse?.displayName ?? null,
      city: reverse?.city ?? null,
      region: reverse?.region ?? null,
      country: reverse?.country ?? null,
      countryCode: reverse?.countryCode?.toUpperCase() ?? null,
      warning: reverse ? null : "已读取链接坐标；公开地图反查暂时不可用，城市和国家信息未自动补齐。",
    };
  }
}
