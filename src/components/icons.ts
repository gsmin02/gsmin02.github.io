/** Line-only icons, matching the Figma set. All 16x16, stroke = currentColor. */
const wrap = (body: string) =>
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">${body}</svg>`;

const stroke = 'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';

export const chevronRight = wrap(`<path d="m6 4 4 4-4 4" ${stroke}/>`);
export const chevronDown = wrap(`<path d="m4 6 4 4 4-4" ${stroke}/>`);
export const chevronUp = wrap(`<path d="m4 10 4-4 4 4" ${stroke}/>`);
export const panelLeft = wrap(
  `<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M6.25 2.75v10.5" stroke="currentColor" stroke-width="1.4"/>`
);
export const sun = wrap(
  `<circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="1.4"/><path d="M8 1.2v1.7M8 13.1v1.7M14.8 8h-1.7M2.9 8H1.2M12.8 3.2l-1.2 1.2M4.4 11.6l-1.2 1.2M12.8 12.8l-1.2-1.2M4.4 4.4L3.2 3.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>`
);
export const moon = wrap(
  `<path d="M13.7 10A6 6 0 016 2.3 6 6 0 1013.7 10z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>`
);
export const check = wrap(`<path d="m3.5 8.3 3 3 6-6.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`);
export const cross = wrap(`<path d="m4.5 4.5 7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`);
