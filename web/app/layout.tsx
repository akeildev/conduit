import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], display: "swap" });

const REPO = "https://github.com/akeildev/conduit";

export const metadata: Metadata = {
  title: "Conduit — Subscription as a Runtime",
  description:
    "Turn any agent CLI you already pay for — Claude, Codex, your own — into the engine that powers an app. Bring your own CLI by config, not code.",
  metadataBase: new URL("https://conduit-six-kappa.vercel.app"),
  openGraph: {
    title: "Conduit — Subscription as a Runtime",
    description:
      "Turn any agent CLI you already pay for into a normalized streaming runtime. Bring your own CLI by config, not code.",
    url: REPO,
    siteName: "Conduit",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Conduit — Subscription as a Runtime",
    description: "Your subscription is the runtime. Bring your own CLI by config, not code.",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.className}>{children}</body>
    </html>
  );
}
