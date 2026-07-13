import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Guestbook",
  description: "Event operations and attendee CRM.",
  icons: {
    icon: "/guestbook-logo.png",
    apple: "/guestbook-logo.png",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
