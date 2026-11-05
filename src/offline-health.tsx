import { createRoot } from 'react-dom/client';
import { QuestionQuest } from './components/QuestionQuest';
import './offline-health.css';

// The offline builder replaces this declaration with a fixed map of data URLs.
// No deployment environment, API registration or remote asset loader is used.
declare const __OFFLINE_HEALTH_ASSETS__: Readonly<Record<string, string>>;
function resolveAsset(path: string): string {
  const embedded = __OFFLINE_HEALTH_ASSETS__[path];
  if (!embedded) throw new Error('This offline copy is missing a required game asset.');
  return embedded;
}

const container = document.getElementById('offline-health-root');
if (!container) throw new Error('The offline game could not find its page.');
createRoot(container).render(<QuestionQuest standalone resolveAsset={resolveAsset} navigate={() => {}}/>);
