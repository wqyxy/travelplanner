import type { ItineraryLanguage, Place } from "./v2-types";

export type PlaceNamePresentation = {
  primary: string;
  secondary: string | null;
  combined: string;
};

export function placeNamePresentation(
  place: Place | null | undefined,
  language: ItineraryLanguage,
  fallback = "地点待定",
): PlaceNamePresentation {
  if (!place) return { primary: fallback, secondary: null, combined: fallback };

  if (language === "zh") {
    return { primary: place.nameZh, secondary: null, combined: place.nameZh };
  }

  const english = place.nameEn || place.nameLocal || place.nameZh;
  if (language === "en") {
    return { primary: english, secondary: null, combined: english };
  }

  const secondary = english !== place.nameZh ? english : null;
  return {
    primary: place.nameZh,
    secondary,
    combined: secondary ? `${place.nameZh} / ${secondary}` : place.nameZh,
  };
}
