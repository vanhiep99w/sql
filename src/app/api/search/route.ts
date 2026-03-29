import { source } from '@/lib/source';
import { createFromSource } from 'fumadocs-core/search/server';

const { staticGET: GET } = createFromSource(source);

export { GET };

// Required for Next.js static export
export const dynamic = 'force-static';
