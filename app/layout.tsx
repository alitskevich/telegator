import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Telegator",
  description: "Telegram news pipeline — operator console",
};

/**
 * §8.2 L718-723. Four routes, all of them operator surfaces; there is no public
 * page and no marketing shell. The Cognito session provider named at L719 is
 * added by item 5.3 once `lib/auth/session.ts` exists — putting an empty
 * provider here now would be a component that authorises nothing while looking
 * like it does.
 */
const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/sources", label: "Sources" },
  { href: "/messages", label: "Messages" },
  { href: "/queues", label: "Queues" },
] as const;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="app-shell">
          <header className="app-header">
            <span className="app-brand">Telegator</span>
            <nav className="app-nav">
              {NAV.map(({ href, label }) => (
                <a key={href} href={href}>
                  {label}
                </a>
              ))}
            </nav>
          </header>
          <main className="app-main">{children}</main>
        </div>
      </body>
    </html>
  );
}
