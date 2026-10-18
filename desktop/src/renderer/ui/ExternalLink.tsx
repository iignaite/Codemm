import type { ReactNode } from 'react';

/** A link that opens in the system browser (main allows https only, §2.1), sending no referrer. */
export function ExternalLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  return <a className={className} href={href} target="_blank" rel="noreferrer">{children}</a>;
}
