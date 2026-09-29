import type { Metadata, Viewport } from "next";
import "./globals.css";

import { loadSettings, themeStyle } from "@/lib/settings/store";

/**
 * The root layout.
 *
 * The theme is written onto `<html>` as inline custom properties, on the
 * server, in the first byte of HTML. That is deliberate: the alternative —
 * reading settings in a client effect — paints the default cyan and then
 * flashes to the user's chosen colour a frame later. On a near-black
 * interface a full-screen colour flash is unmissable, and it is exactly
 * the kind of detail that makes an app feel unfinished.
 *
 * Everything downstream inherits: Tailwind's `@theme inline` block points
 * its colour utilities at these variables, and the orb's canvas reads the
 * same channels back out of computed style, so the 3D renderer and the
 * stylesheet can never disagree about what the accent is.
 */

export async function generateMetadata(): Promise<Metadata> {
  const settings = loadSettings();
  const name = settings.identity.name.trim();
  return {
    title: name ? `Xana · ${name}` : "Xana",
    description:
      "A calm, ambient personal assistant. One orb, one line, and the state of your day.",
    applicationName: "Xana",
  };
}

export async function generateViewport(): Promise<Viewport> {
  const settings = loadSettings();
  const [r, g, b] = settings.appearance.accent
    .trim()
    .split(/[\s,]+/)
    .map((n) => Number(n));

  // A slightly deepened accent, so the browser chrome sits below the
  // interface rather than competing with it.
  const chrome =
    [r, g, b].every((n) => Number.isFinite(n)) && r !== undefined
      ? `#${[r, g, b]
          .map((n) =>
            Math.round(Math.max(0, Math.min(255, (n as number) * 0.28)))
              .toString(16)
              .padStart(2, "0"),
          )
          .join("")}`
      : "#07070A";

  return {
    themeColor: chrome,
    colorScheme: "dark",
    width: "device-width",
    initialScale: 1,
  };
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const style = themeStyle(loadSettings());
  return (
    <html lang="en" className="bg-void" style={style}>
      <body className="bg-void text-text antialiased">
        {/* The ambient light: two very low radial washes that give the void
            a top and a horizon. Fixed and non-interactive, so it never
            scrolls and never eats a click. */}
        <div className="ambient-wash" aria-hidden="true" />
        {children}
      </body>
    </html>
  );
}
