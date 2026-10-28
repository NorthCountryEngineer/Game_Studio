import { createHostSelectionURL } from '../lib/integration';

export type HostSelectionConnection = { status: 'loading' } | { status: 'error' } | { status: 'ready'; origin: string };
/** Selection is public navigation, but a pending/failed alias read cannot choose its source. */
export function HostSelectionLink({ connection, host, gameId, publishedRevision, retry }: {
  connection: HostSelectionConnection;
  host: { origin: string; returnPath: string; name: string };
  gameId: string;
  publishedRevision: number;
  retry: () => void;
}) {
  if (connection.status === 'loading') return <p role="status" className="game-small-note">Checking the application connection before returning this game…</p>;
  if (connection.status === 'error') return <div><p role="status" className="game-small-note">The application connection could not be checked. Your game is still available here.</p><button className="button secondary" type="button" onClick={retry}>Retry connection check</button></div>;
  return <a className="button secondary game-host-selection" href={createHostSelectionURL(host.origin, host.returnPath, connection.origin, gameId, publishedRevision)}>Use this game in {host.name} →</a>;
}
