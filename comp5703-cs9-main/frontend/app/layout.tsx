import type { Metadata } from "next";
import type { ReactNode } from "react";
import WorkspaceMemoryProvider from '@/components/workspace-memory-provider';
import "./globals.css";
import "./product.css";
import "./navigation.css";
import "./landing.css";
import "./how-it-works.css";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "Business API Repository",
    template: "%s | Business API Repository",
  },
  description:
    "Discover, compare and evaluate business APIs for global e-invoicing integrations.",
  openGraph: {
    title: "Business API Repository",
    description: "Discover, compare and evaluate e-invoicing APIs.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Business API Repository",
    description: "Discover, compare and evaluate e-invoicing APIs.",
  },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body><WorkspaceMemoryProvider>{children}</WorkspaceMemoryProvider></body>
    </html>
  );
}
