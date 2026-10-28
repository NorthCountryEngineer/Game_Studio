import { useEffect, useRef, useState } from 'react';
import { applyCrosswordSuggestions, validateCrosswordSuggestionProposal } from '../lib/crossword-suggestions';
import type { CrosswordGeneratorStatus, CrosswordSpec, CrosswordSuggestionProposal } from '../lib/game-types';

export type CrosswordGenerator = {
  status: CrosswordGeneratorStatus;
  generate: () => Promise<{ proposal: CrosswordSuggestionProposal; revision: number }>;
};
type Suggestions = { proposal: CrosswordSuggestionProposal; revision: number; fingerprint: string };

/** Suggestions remain separate from the editable puzzle until the creator applies them. */
export function CrosswordSuggestionsEditor({ spec, revision, dirty, disabled, generator, change }: {
  spec: CrosswordSpec; revision: number; dirty: boolean; disabled: boolean;
  generator: CrosswordGenerator; change: (next: CrosswordSpec) => void;
}) {
  const [pending, setPending] = useState(false), [suggestions, setSuggestions] = useState<Suggestions | null>(null);
  const [selected, setSelected] = useState<number[]>([]), [error, setError] = useState('');
  const request = useRef(0), activeRequest = useRef(false), latest = useRef({ spec, revision, dirty, disabled, generator, change });
  latest.current = { spec, revision, dirty, disabled, generator, change };
  useEffect(() => () => { request.current++; }, []);
  const fingerprint = JSON.stringify(spec);
  const stale = !!suggestions && (suggestions.fingerprint !== fingerprint || suggestions.revision !== revision || dirty);
  const unavailable = !generator.status.available;
  const generateReason = dirty ? 'Save the crossword title, description and other changes before generating suggestions.'
    : unavailable ? generator.status.reason || 'A game administrator can enable a crossword suggestion agent in Settings.'
      : disabled ? 'Wait for the current workshop action to finish.' : '';
  const chosen = suggestions?.proposal.entries.filter((_, index) => selected.includes(index)) ?? [];
  async function generate() {
    const current = latest.current;
    if (current.disabled || current.dirty || !current.generator.status.available || activeRequest.current) return;
    const token = ++request.current, baseline = JSON.stringify(current.spec), startingRevision = current.revision;
    activeRequest.current = true; setPending(true); setError('');
    try {
      const result = await current.generator.generate();
      if (request.current !== token) return;
      const proposal = validateCrosswordSuggestionProposal(result.proposal), now = latest.current;
      if (now.dirty || JSON.stringify(now.spec) !== baseline || proposal.title !== now.spec.title || proposal.description !== now.spec.description
        || !Number.isSafeInteger(result.revision) || result.revision < startingRevision
        || (now.revision !== startingRevision && now.revision !== result.revision)) {
        throw new Error('This crossword changed while suggestions were being generated. Save the current puzzle and generate again.');
      }
      setSuggestions({ proposal, revision: result.revision, fingerprint: baseline });
      setSelected(proposal.entries.map((_, index) => index));
    } catch (value) {
      if (request.current === token) setError(value instanceof Error ? value.message : 'Suggestions could not be generated. Try again.');
    } finally { if (request.current === token) { activeRequest.current = false; setPending(false); } }
  }
  function apply() {
    const current = latest.current;
    if (!suggestions || pending || current.disabled) return;
    if (current.dirty || suggestions.revision !== current.revision || suggestions.fingerprint !== JSON.stringify(current.spec)) {
      setError('These suggestions belong to an earlier saved puzzle. Save your changes and generate again.'); return;
    }
    try {
      const next = applyCrosswordSuggestions(current.spec, chosen);
      current.change(next); setSuggestions(null); setSelected([]); setError('');
    } catch (value) { setError(value instanceof Error ? value.message : 'Select words that fit one connected crossword.'); }
  }
  return <section className="crossword-suggestions-editor" aria-label="Crossword word suggestions">
    <h4>Start with suggested words.</h4>
    <p className="game-small-note">Generate words and clues from this crossword’s saved title and description. Review the options, then choose the ones to use. The saved puzzle is reused every time someone plays, with no model call during play.</p>
    {generator.status.modelName && <p className="crossword-suggestions-model">Suggestion agent: {generator.status.modeName || generator.status.modelName}{generator.status.modeName && ` · ${generator.status.modelName}`}</p>}
    <button type="button" className="button secondary" disabled={disabled || dirty || unavailable || pending} onClick={() => void generate()}>{pending ? 'Generating words & clues…' : 'Generate words & clues'}</button>
    {!pending && generateReason && <p className="game-small-note">{generateReason}</p>}
    {pending && <p role="status">Preparing suggestions. Your current answers and clues stay in place.</p>}
    {suggestions && <div className="crossword-suggestions-results">
      <div className="word-editor-heading"><h4>Review suggested words</h4><span>{chosen.length} selected · {chosen.reduce((sum, entry) => sum + entry.answer.length, 0)} / 200 letters</span></div>
      <p className="game-small-note">Choose 3–16 words that fit one connected grid. Using this selection replaces the current answers and clues in your editable puzzle. Save and playtest it before publishing.</p>
      {stale && <p role="status" className="crossword-suggestions-stale">The saved puzzle has changed. Save your changes and generate fresh suggestions before applying.</p>}
      <fieldset disabled={disabled || pending || stale}><legend className="crossword-suggestions-legend">Suggested answers and clues</legend><ul className="crossword-suggestions-list">{suggestions.proposal.entries.map((entry, index) => <li key={entry.answer}><label><input type="checkbox" checked={selected.includes(index)} onChange={event => { setSelected(current => event.target.checked ? [...current, index] : current.filter(value => value !== index)); setError(''); }}/><span><strong>{entry.answer}</strong><small>{entry.clue}</small></span></label></li>)}</ul>
        <button type="button" className="button secondary" onClick={apply}>Use selected words</button>
      </fieldset>
    </div>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
