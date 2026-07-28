import PropTypes from 'prop-types';
import { teamColorClasses } from '../teamColors.js';

const MEDALS = ['🥇', '🥈', '🥉'];

function ReactionTime({ ms }) {
  if (ms === null || ms === undefined) return <span className="text-gray-500">—</span>;
  return <span className="text-gray-400">{(ms / 1000).toFixed(2)}s</span>;
}

ReactionTime.propTypes = { ms: PropTypes.number };
ReactionTime.defaultProps = { ms: null };

/**
 * Panneau maître pour le mode 'buzzer' : classement des buzzs en direct
 * pendant la lecture, puis attribution manuelle des points une fois stoppé.
 *
 * live    : bool — true pendant la lecture (buzzOrder uniquement, pas d'attribution)
 * rows    : résultats du round (getRoundResults()) — utilisés hors 'playing'
 * buzzOrder : classement en direct (pendant 'playing')
 * teams   : [{ id, name, color }]
 */
export default function BuzzerPanel({ live, rows, buzzOrder, teams, onAward }) {
  const teamById = new Map(teams.map(t => [t.id, t]));

  if (live) {
    return (
      <div className="bg-gray-800 rounded-2xl p-4 space-y-2">
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">Buzzers</h3>
        {buzzOrder.length === 0 ? (
          <p className="text-gray-500 text-sm text-center py-2 animate-pulse">En attente d'un buzz…</p>
        ) : (
          <ol className="space-y-1.5">
            {buzzOrder.map(b => {
              const team = b.teamId ? teamById.get(b.teamId) : null;
              const c    = team ? teamColorClasses(team.color) : null;
              return (
                <li key={b.playerId} className="flex items-center gap-2 bg-gray-700/50 rounded-lg px-3 py-1.5 text-sm">
                  <span className="w-6 text-center shrink-0">{MEDALS[b.order - 1] || `#${b.order}`}</span>
                  {team && <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${c.badge}`}>{team.name}</span>}
                  <span className="flex-1 truncate font-medium text-white">{b.playerName}</span>
                  <ReactionTime ms={b.reactionMs} />
                </li>
              );
            })}
          </ol>
        )}
      </div>
    );
  }

  const buzzed    = rows.filter(r => r.buzz);
  const notBuzzed = rows.filter(r => !r.buzz);

  return (
    <div className="bg-gray-800 rounded-2xl p-4 space-y-3">
      <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">
        Buzzers — attribuer les points
      </h3>
      {rows.length === 0 ? (
        <p className="text-gray-500 text-sm text-center py-2">Aucun joueur</p>
      ) : (
        <div className="space-y-2">
          {[...buzzed, ...notBuzzed].map(r => {
            const team = r.teamId ? teamById.get(r.teamId) : null;
            const c    = team ? teamColorClasses(team.color) : null;
            return (
              <div key={r.playerId} className="bg-gray-700/50 rounded-xl p-3 flex items-center gap-3 flex-wrap">
                <span className="w-6 text-center shrink-0">
                  {r.buzz ? (MEDALS[r.buzz.order - 1] || `#${r.buzz.order}`) : <span className="text-gray-600">—</span>}
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold text-white text-sm truncate">{r.playerName}</span>
                    {team && <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${c.badge}`}>{team.name}</span>}
                  </div>
                  <div className="text-xs">
                    {r.buzz ? <ReactionTime ms={r.buzz.reactionMs} /> : <span className="text-gray-600">N'a pas buzzé</span>}
                  </div>
                </div>

                <div className="ml-auto flex flex-col items-end gap-1">
                  {r.awardedPoints > 0 && (
                    <span className="text-xs text-yellow-400 font-bold">+{r.awardedPoints} attribué{r.awardedPoints > 1 ? 's' : ''}</span>
                  )}
                  <div className="flex items-center gap-1">
                    {[1, 2, 3].map(n => (
                      <button
                        key={n}
                        onClick={() => onAward(r.playerId, n)}
                        className="bg-green-700 hover:bg-green-600 text-white text-xs font-semibold px-2.5 py-1.5 rounded-lg transition-colors"
                      >
                        +{n}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

BuzzerPanel.propTypes = {
  live:        PropTypes.bool,
  rows:        PropTypes.array,
  buzzOrder:   PropTypes.array,
  teams:       PropTypes.array,
  onAward:     PropTypes.func.isRequired,
};

BuzzerPanel.defaultProps = {
  live:      false,
  rows:      [],
  buzzOrder: [],
  teams:     [],
};
