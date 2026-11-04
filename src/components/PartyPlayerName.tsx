type NamedPlayer = { name: string; isAI?: boolean };

export const partyPlayerLabel = (player?: NamedPlayer, fallback = 'Player') => `${player?.name ?? fallback}${player?.isAI ? ' · AI' : ''}`;

/** The AI marker is separate from a player's name and stays visible in compact controls. */
export function PartyPlayerName({ player, fallback = 'Player' }: { player?: NamedPlayer; fallback?: string }) {
  return <>{player?.name ?? fallback}{player?.isAI && <span className="party-ai-badge" aria-label="AI player" style={{ display: 'inline-block', marginInlineStart: '.4em', padding: '.1em .4em', border: '1px solid currentColor', borderRadius: '.4em', fontSize: '.7em', fontWeight: 800, lineHeight: 1.3, verticalAlign: 'middle' }}>AI</span>}</>;
}
