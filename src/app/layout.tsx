import type { ReactNode } from 'react';
import { RootProvider } from 'fumadocs-ui/provider';
import './globals.css';

export const metadata = {
  title: 'SQL Learning',
  description: 'Tài liệu học SQL tiếng Việt — MySQL, PostgreSQL, Oracle',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <RootProvider search={{ options: { type: 'static' } }}>
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
