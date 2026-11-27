import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { KimmiInit } from './kimmi';
import './globals.css';

export const metadata: Metadata = {
  title: 'Paperplane',
  description: 'Invoices that get paid on time.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <KimmiInit />
        <header className="header">
          <Link href="/" className="brand">
            Paperplane
          </Link>
          <nav className="nav">
            <Link href="/pricing" data-testid="nav-pricing">
              Pricing
            </Link>
            <Link href="/signup" className="button primary" data-testid="nav-signup">
              Start free
            </Link>
          </nav>
        </header>
        <main className="main">{children}</main>
      </body>
    </html>
  );
}
