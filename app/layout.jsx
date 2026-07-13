import "./globals.css";

export const metadata = {
  title: "Guestbook",
  description: "Event operations and attendee CRM.",
  icons: {
    icon: "/guestbook-logo.png",
    apple: "/guestbook-logo.png",
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
