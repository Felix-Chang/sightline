import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SightLine",
  description: "A self-organizing graph of visual references, sorted by formal visual language.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
