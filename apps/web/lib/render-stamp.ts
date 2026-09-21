/**
 * Every render of the root layout carries a fresh stamp in this element, so a
 * page can tell whether a refresh it asked for has actually landed.
 */
export const RENDER_STAMP_ID = 'ds-rendered';

export function renderStamp(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
