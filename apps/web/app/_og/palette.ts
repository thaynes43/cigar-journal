// The share cards' palette.
//
// satori (next/og) resolves no CSS variables and no `light-dark()`, so an OG
// route cannot style through the token layer the rest of the app is required to
// use. These literals are that layer's MIRROR for the cards, and
// `token-contrast.test.ts` pins each one against the value `globals.css`
// resolves, so the two cannot drift. This module is the ONLY place outside
// globals.css allowed to name a color (design-tokens.test.ts enforces the rest
// of the tree); everything that draws a card imports from here.
//
// A card is one fixed object, not a themed surface: the ground is always the
// brand orange and the type always espresso, whichever theme the reader's
// machine is in — an unfurled link has no viewer preference to read. The
// ribbon's materials are therefore chosen once, for the orange ground, which is
// neither of the app's two grounds: `ash` is lifted off the dark theme's value
// so ash still separates from the orange behind the stick.
//
// Alpha values are written `rgba(r, g, b, a)` rather than the modern
// space-separated syntax: satori's color parser is not the browser's.

export const OG = {
  brand: "#ea7125",
  ink: "#16110d",
  cream: "#eee5d0",
  wrapper: "#7c5331",
  ember: "#d96b38",
  // Card-specific: between the light and dark themes' ash, picked against orange.
  ash: "#8a8278",
} as const;

// Espresso at the weights the card uses it.
export const INK_EYEBROW = "rgba(22, 17, 13, 0.75)";
export const INK_FRAME = "rgba(22, 17, 13, 0.55)";
export const INK_SEAL_RING = "rgba(22, 17, 13, 0.75)";
export const INK_SEAL_KEYLINE = "rgba(22, 17, 13, 0.35)";
// The stick needs its own outline or it dissolves into the orange ground.
export const INK_STICK_OUTLINE = "rgba(22, 17, 13, 0.6)";

// The cylinder's shading — the same white highlight and black shadow the live
// burn line paints, here as gradient stops satori can read.
export const SHADE_HIGHLIGHT = "#ffffff";
export const SHADE_SHADOW = "#000000";
