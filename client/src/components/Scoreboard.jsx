import { teamColorClasses } from '../teamColors.js';

/**
 * Classement affiché pour les joueurs et dans les résultats.
 *
 * players : [{ id, name, score, teamId }]
 * teams   : [{ id, name, color, score }]  — optionnel, pour afficher les badges/totaux d'équipe
 * myId    : socketId du joueur courant (pour le mettre en évidence)
 */
export default function Scoreboard({ players = [], teams = [], myId }) {
  const sorted = [...players].sort((a, b) => b.score - a.score);
  const teamById = new Map(teams.map(t => [t.id, t]));

  if (!sorted.length) {
    return <p className="text-gray-500 text-sm text-center py-4">Aucun joueur</p>;
  }

  const medals = ['🥇', '🥈', '🥉'];
  const sortedTeams = [...teams].sort((a, b) => b.score - a.score);

  return (
    <div className="space-y-3">
      {sortedTeams.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {sortedTeams.map(t => {
            const c = teamColorClasses(t.color);
            return (
              <span key={t.id} className={`text-xs px-2 py-1 rounded-full font-semibold ${c.badge}`}>
                {t.name} · {t.score} pt{t.score !== 1 ? 's' : ''}
              </span>
            );
          })}
        </div>
      )}

      <ol className="space-y-1">
        {sorted.map((p, i) => {
          const team = p.teamId ? teamById.get(p.teamId) : null;
          const c    = team ? teamColorClasses(team.color) : null;
          return (
            <li
              key={p.id}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                p.id === myId ? 'bg-sky-900/40 border border-sky-700/40' : 'bg-gray-700/50'
              }`}
            >
              <span className="w-6 text-center shrink-0">
                {medals[i] || <span className="text-gray-500 font-mono text-xs">{i + 1}</span>}
              </span>
              {team && <span className={`w-2 h-2 rounded-full shrink-0 ${c.dot}`} title={team.name} />}
              <span className="flex-1 truncate font-medium">
                {p.name}
                {p.id === myId && <span className="ml-1 text-sky-400 text-xs">(moi)</span>}
              </span>
              <span className="font-bold text-white tabular-nums">{p.score} pt{p.score !== 1 ? 's' : ''}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
