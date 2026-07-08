import { useState } from 'react';
import PropTypes from 'prop-types';
import { teamColorClasses } from '../teamColors.js';

/**
 * Gestion des équipes (maître uniquement) : créer/supprimer des équipes et
 * assigner chaque joueur à une équipe (ou aucune).
 *
 * players : [{ id, name, teamId }]
 * teams   : [{ id, name, color }]
 */
export default function TeamManager({ players, teams, onCreateTeam, onDeleteTeam, onAssignTeam }) {
  const [newTeamName, setNewTeamName] = useState('');

  function handleCreate(e) {
    e.preventDefault();
    if (!newTeamName.trim()) return;
    onCreateTeam(newTeamName.trim());
    setNewTeamName('');
  }

  return (
    <div className="bg-gray-800 rounded-2xl p-4 space-y-3">
      <h3 className="text-xs text-gray-400 uppercase tracking-wide">Équipes</h3>

      {/* Créer une équipe */}
      <form onSubmit={handleCreate} className="flex gap-2">
        <input
          type="text"
          value={newTeamName}
          onChange={e => setNewTeamName(e.target.value)}
          placeholder="Nom de l'équipe…"
          maxLength={24}
          className="flex-1 bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-sm
                     text-white placeholder-gray-500 focus:outline-none focus:border-sky-500"
        />
        <button
          type="submit"
          disabled={!newTeamName.trim()}
          className="bg-sky-600 hover:bg-sky-500 disabled:bg-gray-600 disabled:cursor-not-allowed
                     text-white text-sm font-semibold px-3 py-1.5 rounded-lg transition-colors"
        >
          + Équipe
        </button>
      </form>

      {/* Liste des équipes */}
      {teams.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {teams.map(t => {
            const c = teamColorClasses(t.color);
            return (
              <span key={t.id} className={`flex items-center gap-1.5 text-xs pl-2 pr-1 py-1 rounded-full ${c.badge}`}>
                {t.name}
                <button
                  onClick={() => onDeleteTeam(t.id)}
                  title="Supprimer l'équipe"
                  className="w-4 h-4 rounded-full bg-black/20 hover:bg-black/40 flex items-center justify-center leading-none"
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}

      {/* Assignation des joueurs */}
      {players.length === 0 ? (
        <p className="text-gray-500 text-xs text-center py-1">Aucun joueur pour l'instant</p>
      ) : (
        <div className="space-y-1.5">
          {players.map(p => (
            <div key={p.id} className="flex items-center gap-2 bg-gray-700/50 rounded-lg px-2.5 py-1.5">
              <span className="flex-1 truncate text-sm text-gray-200">{p.name}</span>
              <select
                value={p.teamId || ''}
                onChange={e => onAssignTeam(p.id, e.target.value || null)}
                className="bg-gray-700 border border-gray-600 rounded-md px-2 py-1 text-xs text-white
                           focus:outline-none focus:border-sky-500"
              >
                <option value="">Sans équipe</option>
                {teams.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

TeamManager.propTypes = {
  players:       PropTypes.arrayOf(PropTypes.shape({
    id:     PropTypes.string.isRequired,
    name:   PropTypes.string.isRequired,
    teamId: PropTypes.string,
  })).isRequired,
  teams:         PropTypes.arrayOf(PropTypes.shape({
    id:    PropTypes.string.isRequired,
    name:  PropTypes.string.isRequired,
    color: PropTypes.string,
  })).isRequired,
  onCreateTeam:  PropTypes.func.isRequired,
  onDeleteTeam:  PropTypes.func.isRequired,
  onAssignTeam:  PropTypes.func.isRequired,
};
