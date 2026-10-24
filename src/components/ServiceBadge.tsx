import { useBranding } from '../lib/branding';

export function ServiceBadge({ compact = false }: { compact?: boolean }) {
  const brand = useBranding();
  return <span className={`service-badge${compact ? ' compact' : ''}`} aria-label={brand.badgeText}><img src={brand.logoUrl || '/assets/game-studio-mark.svg'} alt="" referrerPolicy="no-referrer" /><span>{brand.badgeText}</span></span>;
}
