import catalog from '../../config/party-games.json';
import '../party-instructions.css';

type Step = [title: string, explanation: string];
type Guide = { premise: string; online: Step[]; inPerson: Step[]; win: string; inPersonWin?: string };

const guides: Record<string, Guide> = {
  'starship-suspects': {
    premise: 'You are all aboard a spaceship. Most players are crew trying to keep it running. One or two secret impostors pretend to help while trying to remove the crew.',
    online: [
      ['Gather your crew', 'One person creates a room and shares the private invitation. Everyone chooses a name and avatar. You need 4–12 players; the host starts when everyone is there.'],
      ['Find out which team you are on', 'Click Reveal my role. This shows whether you are crew or an impostor, and opens your task controls. Keep your role and screen private.'],
      ['Move and complete tasks', 'Click an available connected room card to travel around the ship. Go to the room listed beside one of your tasks, then tap its three symbols in the order shown. The controls briefly rest between moves and task steps.'],
      ['Watch for impostors and sabotage', 'Impostors can fake tasks to blend in, Tag a crewmate in the same room, or choose Sabotage reactor. Tagging turns that crewmate into a ghost. Sabotage starts a 60-second countdown: living players must reach Reactor and complete three repair steps. Tagging and sabotage have cooldowns shown on their buttons.'],
      ['Discuss and vote', 'Report a body in your current room, or use Call a meeting once per game when there is no active sabotage. Living players discuss what they saw in room chat. Click I’m ready to vote to move on sooner, then vote for a suspect or skip. Ties and a winning skip vote eject nobody. Roles stay secret until the game ends.'],
      ['Keep helping if you are out', 'Removed crew become ghosts: you can still move and finish your tasks to help the team win. You cannot chat, vote, report bodies or repair. Keep what you know about the impostor private until the game ends.'],
    ],
    inPerson: [
      ['Gather the group', 'Add 4–12 names and avatars. Keep these host controls on your own display and use Open game screen for the group.'],
      ['Give out secret roles', 'Use Private host controls to deal or assign crew and impostor roles. Tell each person their role privately, or use physical role cards. Start the game when everyone understands their team.'],
      ['Play tasks and meetings in the room', 'Agree on simple physical tasks for the crew and how impostors can tag someone. This mode does not use online room cards or symbol puzzles. Record tasks with + Task complete, use Call sabotage or Repair ship, and mark players out or bring them back beside their names. Agree on a sabotage time limit and use Round timer to count it down.'],
      ['Lead the vote and record the result', 'Use Advance phase for tasks, meetings and voting. Count votes in person, record who is out, adjust scores and show an announcement. The host decides when a team has won and clicks Finish game; roles can then be revealed to everyone.'],
    ],
    win: 'Crew win by finishing all crew tasks or ejecting every impostor. Impostors win when they equal or outnumber the living crew, or when the reactor countdown expires without a repair.',
    inPersonWin: 'Crew finish the group’s tasks or vote out every impostor. Impostors win when they equal or outnumber the remaining crew, or the agreed sabotage timer expires. The host records the outcome.',
  },
  mafia: {
    premise: 'A town has secret Mafia members hiding among its civilians. Each night the Mafia choose someone to remove, a Doctor can protect someone, and a Detective can investigate. During the day, the town talks and votes.',
    online: [
      ['Choose a narrator and gather the town', 'Invite 5–24 players. A human narrator sits out, so you need at least five players plus that narrator. With AI narration, everyone—including the host—plays. The host can hand human narration to someone else before starting.'],
      ['Read your private role', 'Keep your role to yourself. Mafia work together and have their own private chat. The Doctor protects someone, including themselves if they wish. The Detective checks another player. Civilians listen and help the town decide who to trust.'],
      ['Make night choices', 'When night begins, the Mafia, Doctor and Detective use their private controls to choose a target. Civilians wait for morning. A human narrator leads the phases; AI narration advances them automatically.'],
      ['Discuss and vote in the day', 'Read the night’s result and share theories in town chat. Vote by clicking a player, or skip. Ties eliminate nobody. If you are removed, watch quietly without sharing your secret information.'],
    ],
    inPerson: [
      ['Add players and keep host controls private', 'Add at least five names; you can narrate without adding yourself as a player. Open the separate game screen for the group.'],
      ['Deal secret roles', 'Use Private host controls to deal random roles or assign them yourself. Tell players privately or use role cards. Explain Mafia, Detective, Doctor and Civilian before starting.'],
      ['Narrate the night and day', 'At night, privately collect the Mafia target, Doctor protection and Detective investigation. Announce the public outcome and mark anyone who is out. Use Advance phase for discussion and voting; collect and count votes in person.'],
      ['Keep the screen up to date', 'Adjust points beside names, show public announcements and use Undo last update for a mistake. When a team wins, click Finish game. Reveal all roles only when you are ready.'],
    ],
    win: 'The town wins when every Mafia member is out. The Mafia win when they equal or outnumber the remaining town players. The narrator is not counted as a player.',
  },
  'sketch-guess': {
    premise: 'One person draws a secret prompt while everyone else tries to guess it. The artist changes each turn.',
    online: [
      ['Gather the artists', 'Invite 2–12 players. The host chooses the number of rounds and time per round, then starts.'],
      ['Draw or guess', 'Only the artist sees the prompt. Draw on the shared canvas using the brush controls, without writing the answer or saying it aloud. Other players type guesses into Your guess.'],
      ['Score and take turns', 'A correct guess earns 100 points for the guesser and 30 for the artist. Keep the answer quiet after you guess it. The answer is revealed when everyone guesses or time runs out; the next turn changes artist and clears the canvas.'],
    ],
    inPerson: [
      ['Set up a drawing space', 'Add 2–12 names and open the game screen. Have paper or a whiteboard ready; drawing in this mode happens in person.'],
      ['Give the artist a prompt privately', 'Start the game, then use Private host controls to show the prompt only to the named artist. You can enter a custom prompt. Everyone else calls out guesses.'],
      ['Record guesses and rotate artists', 'Award points beside successful guessers, then choose Reveal drawing prompt. Next round changes the artist. Finish game when your group is done.'],
    ],
    win: 'The highest score after the last round wins. Tied scores share the result.',
  },
  trivia: {
    premise: 'Everyone answers the same question. Pick one of four choices, then see which answer was correct.',
    online: [
      ['Choose your rounds', 'Invite 2–24 players. The host chooses the number of rounds and time per question.'],
      ['Lock in an answer', 'Click one answer. Your choice locks in and stays private. The correct answer is revealed when everyone responds or time runs out.'],
      ['Collect points', 'A correct answer earns 100 points plus a small speed bonus. The next question starts after the reveal; the host can also choose Next round.'],
    ],
    inPerson: [
      ['Gather the group', 'Add 2–24 names and open the game screen. Start the game to show the first question.'],
      ['Collect answers', 'Have players write, say or otherwise submit their choices to you. Private host controls let you enter your own question, four choices and the correct answer.'],
      ['Reveal and score', 'Choose Reveal answer when everyone is ready. Award points beside players who answered correctly, then choose Next round. Finish game when you are done.'],
    ],
    win: 'The player with the most points after the last question wins. Tied scores share the result.',
  },
  'hand-duel': {
    premise: 'Two players secretly choose rock, paper or scissors, then reveal together. Rock beats scissors, scissors beat paper, and paper beats rock.',
    online: [
      ['Invite one opponent', 'Create a private room, share its invitation with one other player, and start when both have joined.'],
      ['Choose a hand', 'Click Rock, Paper or Scissors. Your choice locks and stays private until both players choose or time runs out.'],
      ['Reveal and repeat', 'A winning hand earns one point. Matching hands are a tie and earn no points. The next hand starts automatically after the reveal.'],
    ],
    inPerson: [
      ['Add the two players', 'Open the separate game screen, then start. Have both players choose their hands privately.'],
      ['Record and reveal together', 'Enter both hands in Private host controls, then click Reveal both hands & score. A winning hand automatically earns one point; ties score nothing.'],
      ['Play another hand', 'Next round clears the choices. Play to three points, or agree on your own finish, then click Finish game.'],
    ],
    win: 'The first player to win three hands wins the online match. Tied hands do not count toward that target.',
    inPersonWin: 'Play until someone wins three hands, or use the finish your group agreed on. Matching hands are a tie and score no points.',
  },
  'drop-four': {
    premise: 'Two players take turns dropping discs into a board. Try to connect four of your own discs before your opponent does.',
    online: [
      ['Invite one opponent', 'Create a room, share its invitation with one other player, and start when both have joined.'],
      ['Take turns dropping discs', 'When it is your turn, click the arrow above a column. Your disc falls to the lowest empty space. A full column cannot take another disc.'],
      ['Look in every direction', 'Four discs in a row can run across, up or diagonally. A full board with no connection is a draw. Play before your turn timer ends; running out of time awards the win to your opponent.'],
    ],
    inPerson: [
      ['Add the two players', 'Open the separate game screen and start. The lead operates the board while players call out their chosen columns.'],
      ['Record each move', 'Click the column a player chooses. The board takes turns automatically and checks for four in a row or a draw. A winner earns one point.'],
      ['Keep playing', 'Choose Next round to clear the board and switch the starting player, or Finish game to end the session.'],
    ],
    win: 'Connect four of your discs horizontally, vertically or diagonally. Block your opponent’s connections while building your own.',
  },
};

/** Static public rules only. Reading or toggling help never sends a game action. */
export function PartyInstructions({ kind, mode = 'online' }: { kind: string; mode?: 'online' | 'in-person' }) {
  const guide = guides[kind], game = catalog.games.find(value => value.id === kind);
  if (!guide || !game) return null;
  const inPerson = mode === 'in-person';
  return <details key={`${kind}:${mode}`} className="party-instructions">
    <summary><span><strong>How to play</strong><span>{game.title}</span></span><span className="party-guide-toggle" aria-hidden="true"><span className="party-guide-open">Open guide</span><span className="party-guide-close">Close guide</span><span>⌄</span></span></summary>
    <div className="party-guide-content">
      <p className="party-guide-premise">{guide.premise}</p>
      <p className="party-guide-mode">{inPerson ? 'Playing together in person · the lead controls the game' : 'Playing online · everyone uses their own screen'}</p>
      <ol>{(inPerson ? guide.inPerson : guide.online).map(([title, explanation]) => <li key={title}><strong>{title}</strong><p>{explanation}</p></li>)}</ol>
      <aside><h3>How to win</h3><p>{inPerson ? guide.inPersonWin ?? guide.win : guide.win}</p>{inPerson && <p>The lead records in-person results and decides when to finish. Use Undo last update to correct a mistake.</p>}</aside>
      {!inPerson && <p className="party-guide-timer-note">The game keeps running while you read. You can open this guide before the host starts, and close it whenever you’re ready.</p>}
    </div>
  </details>;
}
