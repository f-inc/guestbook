import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  metadataBase: new URL("https://guestbook.f.inc"),
  title: "Guestbook",
  description: "Event operations and attendee CRM.",
  applicationName: "Guestbook",
  icons: {
    icon: "/guestbook-logo.png",
    apple: "/guestbook-logo.png",
  },
  openGraph: {
    type: "website",
    title: "Guestbook",
    description: "Event operations and attendee CRM.",
    siteName: "Guestbook",
    images: [
      {
        url: "/guestbook-banner.png",
        width: 1200,
        height: 630,
        alt: "Guestbook",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Guestbook",
    description: "Event operations and attendee CRM.",
    images: ["/guestbook-banner.png"],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
