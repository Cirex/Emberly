import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Emberly Apartments",
    template: "%s | Emberly Apartments",
  },
  description: "Emberly Apartments — property access & management platform",
  robots: {
    index: false,
    follow: false,
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-cream text-primary antialiased">{children}</body>
    </html>
  );
}
