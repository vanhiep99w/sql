'use client';

import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { SourceExplorerProvider } from '@vanhiep99w/docs-kit/components/source-explorer';

export function DocsSourceProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <SourceExplorerProvider
      navigationKey={pathname}
      manifestUrl="/source-examples/manifest.json"
      scrollAnchorSelector="#nd-page .prose > *"
    >
      {children}
    </SourceExplorerProvider>
  );
}
