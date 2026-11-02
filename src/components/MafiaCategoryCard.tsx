export function MafiaCategoryCard({ navigate }: { navigate: (path: string) => unknown }) {
  return <section className="mafia-category-card" aria-labelledby="mafia-category-heading">
    <div className="mafia-category-art" aria-hidden="true"><span>☾</span><i>?</i><b>✦</b></div>
    <div><span className="eyebrow">SOCIAL DEDUCTION · LIVE PARTY GAMES</span><h2 id="mafia-category-heading">A town full of secrets.</h2><p>Play Mafia together online. Choose an avatar, discover your secret role, and decide who to trust. Private rooms for 5–24 players, with a human or AI narrator.</p><button className="button primary" onClick={() => void navigate('/mafia')}>Host or join Mafia →</button><small>No account needed to play. Share your invitation with your group.</small></div>
  </section>;
}
