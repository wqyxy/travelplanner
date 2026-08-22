export function shouldActivateSelectionKey(key: string, isDirectTarget: boolean) {
  return isDirectTarget && (key === "Enter" || key === " ");
}

export function shouldApplyMapLayout(currentGeneration: number, requestedGeneration: number, hasMap: boolean, pointCount: number) {
  return currentGeneration === requestedGeneration && hasMap && pointCount > 0;
}

export function shouldRequestFullscreenLayout(previousFullscreen: boolean | null, fullscreen: boolean) {
  return previousFullscreen !== null && previousFullscreen !== fullscreen;
}
