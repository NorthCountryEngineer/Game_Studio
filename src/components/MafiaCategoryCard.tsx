export function MafiaCategoryCard({ navigate }: { navigate: (path: string) => unknown }) {
  return <section className="mafia-category-card" aria-labelledby="mafia-category-heading">
    <div className="mafia-category-art" aria-hidden="true"><span>☾</span><i>?</i><b>✦</b></div>
    <div><span className="eyebrow">PARTY GAMES · ONLINE OR IN PERSON</span><h2 id="mafia-category-heading">Bring your people. Pick your game.</h2><p>Uncover a hidden impostor, draw something ridiculous or challenge a friend. Six party games for two people or a whole group, with a shared screen for in-person play.</p><button className="button primary" onClick={() => void navigate('/party')}>Explore party games →</button><small>No account needed to play. Private rooms, or host the game on one screen.</small></div>
  </section>;
}
