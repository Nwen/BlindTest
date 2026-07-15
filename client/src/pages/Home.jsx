import { useState } from 'react';
import PropTypes from 'prop-types';

const TABS = [
  { id: 'join',   label: 'Rejoindre' },
  { id: 'create', label: 'Créer' },
  { id: 'rejoin', label: 'Reprendre (MJ)' },
];

export default function Home({ onCreateGame, onJoinGame, onRejoinMaster, error }) {
  const [tab,        setTab]        = useState('join');
  const [roomCode,   setRoomCode]   = useState('');
  const [name,       setName]       = useState('');
  const [mjRoomCode, setMjRoomCode] = useState('');
  const [mjToken,    setMjToken]    = useState('');

  function handleJoin(e) {
    e.preventDefault();
    if (!roomCode.trim() || !name.trim()) return;
    onJoinGame(roomCode.trim().toUpperCase(), name.trim());
  }

  function handleRejoin(e) {
    e.preventDefault();
    if (!mjRoomCode.trim() || !mjToken.trim()) return;
    onRejoinMaster(mjRoomCode.trim().toUpperCase(), mjToken.trim().toUpperCase());
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4">
      {/* Logo */}
      <div className="mb-8 text-center">
        <div className="text-6xl mb-3">🎵</div>
        <h1 className="text-4xl font-bold text-white tracking-tight">BlindTest</h1>
      </div>

      {/* Card */}
      <div className="w-full max-w-sm bg-gray-800 rounded-2xl shadow-2xl overflow-hidden">
        {/* Onglets */}
        <div className="flex border-b border-gray-700">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex-1 py-3 text-xs font-medium transition-colors ${
                tab === t.id
                  ? 'text-sky-400 border-b-2 border-sky-400'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="p-6">
          {error && (
            <div className="mb-4 text-red-400 text-sm bg-red-900/30 border border-red-700/50 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          {/* ── Rejoindre comme joueur ── */}
          {tab === 'join' && (
            <form onSubmit={handleJoin} className="space-y-4">
              <div>
                <label htmlFor="join-code" className="block text-xs text-gray-400 mb-1 uppercase tracking-wide">
                  Code de la partie
                </label>
                <input
                  id="join-code"
                  type="text"
                  value={roomCode}
                  onChange={e => setRoomCode(e.target.value.toUpperCase())}
                  placeholder="ex : AB3X"
                  maxLength={6}
                  className="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-3
                             text-white text-lg tracking-widest font-mono placeholder-gray-500
                             focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                />
              </div>
              <div>
                <label htmlFor="join-name" className="block text-xs text-gray-400 mb-1 uppercase tracking-wide">
                  Ton pseudo
                </label>
                <input
                  id="join-name"
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="ex : Nwen"
                  maxLength={20}
                  className="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-3
                             text-white text-lg tracking-widest font-mono placeholder-gray-500
                             focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                />
              </div>
              <button
                type="submit"
                disabled={!roomCode.trim() || !name.trim()}
                className="w-full bg-sky-600 hover:bg-sky-500 disabled:bg-gray-600 disabled:cursor-not-allowed
                           text-white font-semibold py-3 rounded-lg transition-colors"
              >
                Rejoindre
              </button>
            </form>
          )}

          {/* ── Créer une partie ── */}
          {tab === 'create' && (
            <div className="space-y-4">
              <p className="text-gray-400 text-sm text-center">
                Tu deviendras le <span className="text-sky-400 font-semibold">maître du jeu</span> et
                tu contrôleras la musique et les points.
              </p>
              <button
                onClick={onCreateGame}
                className="w-full bg-violet-600 hover:bg-violet-500 text-white font-semibold py-3
                           rounded-lg transition-colors"
              >
                Créer la partie
              </button>
            </div>
          )}

          {/* ── Reprendre comme maître ── */}
          {tab === 'rejoin' && (
            <form onSubmit={handleRejoin} className="space-y-4">
              <p className="text-xs text-gray-400 text-center">
                Utilise les codes affichés dans ton panneau MJ pour reprendre la partie.
              </p>
              <div>
                <label htmlFor="mj-room" className="block text-xs text-gray-400 mb-1 uppercase tracking-wide">
                  Code de la partie
                </label>
                <input
                  id="mj-room"
                  type="text"
                  value={mjRoomCode}
                  onChange={e => setMjRoomCode(e.target.value.toUpperCase())}
                  placeholder="ex : AB3X"
                  maxLength={6}
                  className="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-3
                             text-white text-lg tracking-widest font-mono placeholder-gray-500
                             focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                />
              </div>
              <div>
                <label htmlFor="mj-token" className="block text-xs text-gray-400 mb-1 uppercase tracking-wide">
                  Code maître (mot de 8 lettres)
                </label>
                <input
                  id="mj-token"
                  type="text"
                  value={mjToken}
                  onChange={e => setMjToken(e.target.value.toUpperCase())}
                  placeholder="ex : SANDWICH"
                  maxLength={8}
                  className="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-3
                             text-white text-lg tracking-widest font-mono placeholder-gray-500
                             focus:outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500"
                />
              </div>
              <button
                type="submit"
                disabled={mjRoomCode.length < 6 || mjToken.length < 8}
                className="w-full bg-violet-600 hover:bg-violet-500 disabled:bg-gray-600 disabled:cursor-not-allowed
                           text-white font-semibold py-3 rounded-lg transition-colors"
              >
                Reprendre comme maître
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

Home.propTypes = {
  onCreateGame:   PropTypes.func.isRequired,
  onJoinGame:     PropTypes.func.isRequired,
  onRejoinMaster: PropTypes.func.isRequired,
  error:          PropTypes.string,
};

Home.defaultProps = {
  error: '',
};
