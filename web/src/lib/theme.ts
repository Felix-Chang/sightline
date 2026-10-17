// Canvas colors for PixiJS. Keep in sync with the @theme tokens in app/globals.css.
export const theme = {
  canvas: 0xefeee9,
  surface: 0xffffff,
  border: 0xdcdad3,
  fg: 0x1c1c1a,
  muted: 0x6f6c64,
  accent: 0xc8312f,
} as const;

/**
 * One colour per anchor, assigned by anchor index so a given subclass always keeps the
 * same hue. All six sit at the same OKLab lightness as `accent` (L 0.550), so none reads
 * heavier than another, and each clears 4.5:1 on white. Ordered for maximum separation
 * when a category has only two or three anchors.
 */
export const anchorPalette = [
  0xc8312f, // red (same as accent)
  0x3f66de, // blue
  0x04892e, // green
  0x8e6c01, // ochre
  0x00818d, // teal
  0xa73eaa, // magenta
] as const;

export const anchorColor = (i: number) => anchorPalette[i % anchorPalette.length];

/** Same palette as a CSS colour, for the DOM panels. */
export const anchorHex = (i: number) => `#${anchorColor(i).toString(16).padStart(6, "0")}`;

export const canvasHex = "#efeee9";
