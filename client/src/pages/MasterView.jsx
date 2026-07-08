import { useState, useEffect, useRef } from 'react';
import socket from '../socket.js';
import Scoreboard    from '../components/Scoreboard.jsx';
import PlaylistPanel from '../components/PlaylistPanel.jsx';
import FileBrowser   from '../components/FileBrowser.jsx';
import TeamManager   from '../components/TeamManager.jsx';
import BuzzerPanel   from '../components/BuzzerPanel.jsx';

/**
 * Vue maître du jeu.
 *
 * masterInfo   : { roomCode, masterToken }
 * initialState : état du jeu récupéré à la connexion
 */
export default function MasterView({ masterInfo, initialState }) {
  const { roomCode, masterToken: token } = masterInfo;

  const [phase,          setPhase]        = useState(initialState?.phase    || 'lobby');
  const [mode,           setMode]         = useState(initialState?.mode    || 'text');
  const [players,        setPlayers]      = useState(initialState?.players  || []);
  const [teams,          setTeams]        = useState(initialState?.teams    || []);
  const [playlist,       setPlaylist]     = useState(initialState?.playlist || []);
  const [currentIndex,   setCurrentIndex] = useState(initialState?.currentTrackIndex ?? -1);
  const [currentMeta,    setCurrentMeta]  = useState(null);
  const [results,        setResults]      = useState([]);    // getRoundResults()
  const [answers,        setAnswers]      = useState({});    // socketId → { artist, title }
  const [roundAwards,    setRoundAwards]  = useState({});    // socketId → { artist, title } | points
  const [buzzOrder,      setBuzzOrder]    = useState([]);    // classement des buzzs en direct
  const [showBrowser,    setShowBrowser]  = useState(false);
  const [audioUrl,       setAudioUrl]     = useState('');
  const [copied,         setCopied]       = useState(false);
  const [gameOver,       setGameOver]     = useState(false);
  const [notification,   setNotification] = useState('');
  const audioRef = useRef(null);

  // ── Events socket ──────────────────────────────────────────────────────────
  useEffect(() => {
    function onState(s) {
      setPhase(s.phase);
      setMode(s.mode);
      setPlayers(s.players);
      setTeams(s.teams || []);
      setCurrentIndex(s.currentTrackIndex);
    }

    function onPlayerJoined(p) {
      setPlayers(prev => prev.find(x => x.id === p.id) ? prev : [...prev, p]);
      notify(`${p.name} a rejoint la partie`);
    }

    function onPlayerLeft({ playerId }) {
      setPlayers(prev => prev.filter(p => p.id !== playerId));
    }

    function onPlaylistUpdated(pl) {
      setPlaylist(pl);
    }

    function onTrackReady({ trackId }) {
      setPlaylist(prev => prev.map(t => t.id === trackId ? { ...t, status: 'ready' } : t));
      notify('Piste prête');
    }

    function onTrackPlaying({ audioUrl: url, index }) {
      setAudioUrl(url);
      setPhase('playing');
      setCurrentIndex(index);
      setResults([]);
      setAnswers({});
      setRoundAwards({});
      setBuzzOrder([]);
      if (audioRef.current) {
        audioRef.current.src = url;
        audioRef.current.load();
        audioRef.current.play().catch(() => {});
      }
    }

    function onTrackMeta(meta) {
      setCurrentMeta(meta);
    }

    function onTrackStopped() {
      setPhase('stopped');
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
      }
    }

    function onPlayerAnswered({ playerId, playerName, answer }) {
      setAnswers(prev => ({ ...prev, [playerId]: answer }));
      notify(`${playerName} a répondu`);
    }

    function onAnswersSnapshot({ answers: ans, awards, results: res }) {
      setAnswers(ans);
      setRoundAwards(awards);
      setResults(res);
    }

    function onResultsUpdate(res) {
      setResults(res);
    }

    function onBuzzUpdate({ buzzOrder: order }) {
      setBuzzOrder(order);
    }

    function onResultsRevealed({ results: res }) {
      setResults(res);
      setPhase('results');
    }

    function onRoundReset({ nextTrackIndex }) {
      setPhase('lobby');
      setCurrentIndex(nextTrackIndex);
      setCurrentMeta(null);
      setResults([]);
      setAnswers({});
      setRoundAwards({});
      setBuzzOrder([]);
      setAudioUrl('');
      if (audioRef.current) {
        audioRef.current.src = '';
        audioRef.current.pause();
      }
    }

    function onGameOver({ scores }) {
      setPlayers(scores);
      setGameOver(true);
      setPhase('results');
    }

    socket.on('state',             onState);
    socket.on('player-joined',     onPlayerJoined);
    socket.on('player-left',       onPlayerLeft);
    socket.on('playlist-updated',  onPlaylistUpdated);
    socket.on('track-ready',       onTrackReady);
    socket.on('track-playing',     onTrackPlaying);
    socket.on('track-meta',        onTrackMeta);
    socket.on('track-stopped',     onTrackStopped);
    socket.on('player-answered',   onPlayerAnswered);
    socket.on('answers-snapshot',  onAnswersSnapshot);
    socket.on('results-update',    onResultsUpdate);
    socket.on('results-revealed',  onResultsRevealed);
    socket.on('buzz-update',       onBuzzUpdate);
    socket.on('round-reset',       onRoundReset);
    socket.on('game-over',         onGameOver);

    return () => {
      socket.off('state',             onState);
      socket.off('player-joined',     onPlayerJoined);
      socket.off('player-left',       onPlayerLeft);
      socket.off('playlist-updated',  onPlaylistUpdated);
      socket.off('track-ready',       onTrackReady);
      socket.off('track-playing',     onTrackPlaying);
      socket.off('track-meta',        onTrackMeta);
      socket.off('track-stopped',     onTrackStopped);
      socket.off('player-answered',   onPlayerAnswered);
      socket.off('answers-snapshot',  onAnswersSnapshot);
      socket.off('results-update',    onResultsUpdate);
      socket.off('results-revealed',  onResultsRevealed);
      socket.off('buzz-update',       onBuzzUpdate);
      socket.off('round-reset',       onRoundReset);
      socket.off('game-over',         onGameOver);
    };
  }, []);

  // ── Helpers notification ──────────────────────────────────────────────────
  const notifTimer = useRef(null);
  function notify(msg) {
    setNotification(msg);
    clearTimeout(notifTimer.current);
    notifTimer.current = setTimeout(() => setNotification(''), 3000);
  }

  // ── Copier le code ────────────────────────────────────────────────────────
  function copyCode() {
    navigator.clipboard.writeText(roomCode).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  // ── Commandes maître ──────────────────────────────────────────────────────
  function cmd(event, payload = {}) {
    return new Promise(resolve =>
      socket.emit(event, { token, ...payload }, resolve)
    );
  }

  async function handlePlay(index) {
    const res = await cmd('master:play', { index: index ?? currentIndex });
    if (!res.ok) notify(res.error || 'Erreur');
  }

  async function handleStop() {
    await cmd('master:stop');
  }

  async function handleReplay() {
    await cmd('master:replay');
  }

  async function handleReveal() {
    await cmd('master:reveal');
  }

  async function handleNext() {
    const res = await cmd('master:next');
    if (res?.gameOver) setGameOver(true);
  }

  async function handleAward(playerId, field, value) {
    setRoundAwards(prev => ({
      ...prev,
      [playerId]: { ...(prev[playerId] || {}), [field]: value },
    }));
    await cmd('master:award', { playerId, field, value });
  }

  async function handleBuzzerAward(playerId, points) {
    const res = await cmd('master:buzzer-award', { playerId, points });
    if (!res?.ok) notify(res?.error || 'Erreur');
  }

  async function handleBuzzerAwardTeam(teamId, points) {
    const res = await cmd('master:buzzer-award', { teamId, points });
    if (!res?.ok) notify(res?.error || 'Erreur');
  }

  async function handleSetMode(newMode) {
    if (newMode === mode) return;
    const res = await cmd('master:set-mode', { mode: newMode });
    if (res.ok) setMode(newMode);
    else notify(res.error || 'Erreur');
  }

  async function handleCreateTeam(name) {
    await cmd('master:create-team', { name });
  }

  async function handleDeleteTeam(teamId) {
    await cmd('master:delete-team', { teamId });
  }

  async function handleAssignTeam(playerId, teamId) {
    await cmd('master:assign-team', { playerId, teamId });
  }

  async function handleAddYoutube(url) {
    await cmd('master:add-youtube', { url });
  }

  async function handleImportPlaylist(playlistUrl) {
    const res = await cmd('master:import-playlist', { playlistUrl });
    if (res?.ok) notify(`${res.count} pistes importées`);
    else notify(res?.error || 'Erreur');
  }

  async function handleRemove(index) {
    await cmd('master:remove-track', { index });
  }

  function handleSelectFile(filePath) {
    cmd('master:add-local', { filePath });
    setShowBrowser(false);
  }

  // ── Piste courante (pour le maître) ───────────────────────────────────────
  const currentTrack = playlist[currentIndex];

  // ── Affichage ──────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex flex-col p-3 gap-3 max-w-5xl mx-auto">

      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-lg font-bold text-white">Maître du jeu</h1>

        {/* Code partie (pour les joueurs) */}
        <div className="flex items-center gap-2 bg-gray-800 rounded-xl px-3 py-1.5">
          <span className="text-xs text-gray-400 uppercase tracking-wide">Partie</span>
          <span className="font-mono font-bold text-xl text-white tracking-widest">{roomCode}</span>
          <button
            onClick={copyCode}
            className="text-xs text-gray-400 hover:text-white ml-1 transition-colors"
          >
            {copied ? '✓ Copié' : 'Copier'}
          </button>
        </div>

        {/* Code maître (pour se reconnecter) */}
        <div className="flex items-center gap-2 bg-gray-800 rounded-xl px-3 py-1.5" title="Note ce code pour reprendre la partie si tu te déconnectes">
          <span className="text-xs text-gray-400 uppercase tracking-wide">Code MJ</span>
          <span className="font-mono font-bold text-sm text-violet-300 tracking-widest">{token}</span>
        </div>

        {/* Mode de jeu */}
        <div
          className="flex items-center bg-gray-800 rounded-xl p-1 gap-1"
          title={phase === 'playing' ? 'Impossible de changer de mode pendant la lecture' : ''}
        >
          {[{ id: 'text', label: 'Texte' }, { id: 'buzzer', label: 'Buzzer' }].map(m => (
            <button
              key={m.id}
              onClick={() => handleSetMode(m.id)}
              disabled={phase === 'playing'}
              className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                mode === m.id ? 'bg-sky-600 text-white' : 'text-gray-400 hover:text-white'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        {notification && (
          <span className="text-xs text-gray-400 bg-gray-800 rounded-full px-3 py-1 animate-pulse">
            {notification}
          </span>
        )}
      </div>

      {/* Layout principal : 2 colonnes sur desktop */}
      <div className="flex flex-col lg:flex-row gap-3 flex-1">

        {/* ── Colonne gauche : Playlist ── */}
        <div className="lg:w-80 bg-gray-800 rounded-2xl overflow-hidden flex flex-col" style={{ minHeight: '400px' }}>
          <PlaylistPanel
            playlist={playlist}
            currentIndex={currentIndex}
            onAddYoutube={handleAddYoutube}
            onImportPlaylist={handleImportPlaylist}
            onOpenBrowser={() => setShowBrowser(true)}
            onRemove={handleRemove}
            onPlay={handlePlay}
          />
        </div>

        {/* ── Colonne droite ── */}
        <div className="flex-1 flex flex-col gap-3">

          {/* Lecteur + contrôles */}
          <div className="bg-gray-800 rounded-2xl p-4 space-y-3">
            {/* Métadonnées de la piste courante */}
            {currentMeta ? (
              <div className="text-center">
                <p className="text-lg font-bold text-white">{currentMeta.title}</p>
                <p className="text-sky-400 text-sm">{currentMeta.artist}</p>
                {currentMeta.album && (
                  <p className="text-xs text-gray-400">
                    {currentMeta.album}{currentMeta.year ? ` · ${currentMeta.year}` : ''}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-center text-gray-500 text-sm">
                {currentTrack ? currentTrack.metadata?.title : 'Aucune piste sélectionnée'}
              </p>
            )}

            <audio ref={audioRef} controls className="w-full rounded-lg accent-sky-500" />

            {/* Boutons de contrôle */}
            <div className="flex flex-wrap gap-2 justify-center">
              {phase !== 'playing' && currentIndex >= 0 && (
                <button
                  onClick={() => handlePlay(currentIndex)}
                  disabled={playlist[currentIndex]?.status !== 'ready'}
                  className="flex-1 min-w-[120px] bg-green-700 hover:bg-green-600 disabled:bg-gray-600
                             text-white font-semibold py-2 px-4 rounded-lg transition-colors text-sm"
                >
                  ▶ Lancer
                </button>
              )}
              {phase === 'playing' && (
                <>
                  <button
                    onClick={handleStop}
                    className="flex-1 min-w-[120px] bg-red-700 hover:bg-red-600 text-white
                               font-semibold py-2 px-4 rounded-lg transition-colors text-sm"
                  >
                    ⏹ Stopper
                  </button>
                  <button
                    onClick={handleReplay}
                    className="bg-gray-600 hover:bg-gray-500 text-white py-2 px-3 rounded-lg transition-colors text-sm"
                  >
                    ↺ Relancer
                  </button>
                </>
              )}
              {(phase === 'stopped' || phase === 'results') && !gameOver && (
                <>
                  {phase === 'stopped' && (
                    <>
                      <button
                        onClick={handleReveal}
                        className="flex-1 min-w-[120px] bg-violet-700 hover:bg-violet-600 text-white
                                   font-semibold py-2 px-4 rounded-lg transition-colors text-sm"
                      >
                        Révéler les résultats
                      </button>
                      <button
                        onClick={handleReplay}
                        className="bg-gray-600 hover:bg-gray-500 text-white py-2 px-3 rounded-lg text-sm"
                      >
                        ↺ Rejouer
                      </button>
                    </>
                  )}
                  {phase === 'results' && (
                    <button
                      onClick={handleNext}
                      className="flex-1 min-w-[120px] bg-sky-700 hover:bg-sky-600 text-white
                                 font-semibold py-2 px-4 rounded-lg transition-colors text-sm"
                    >
                      Piste suivante ⏭
                    </button>
                  )}
                </>
              )}
              {phase === 'lobby' && playlist.length > 0 && (
                <button
                  onClick={() => handlePlay(currentIndex < 0 ? 0 : currentIndex)}
                  disabled={playlist[currentIndex < 0 ? 0 : currentIndex]?.status !== 'ready'}
                  className="flex-1 min-w-[120px] bg-green-700 hover:bg-green-600 disabled:bg-gray-600
                             text-white font-semibold py-2 px-4 rounded-lg transition-colors text-sm"
                >
                  ▶ Démarrer
                </button>
              )}
            </div>
          </div>

          {/* Buzzers en direct (mode 'buzzer', pendant la lecture) */}
          {mode === 'buzzer' && phase === 'playing' && (
            <BuzzerPanel live buzzOrder={buzzOrder} teams={teams} onAward={handleBuzzerAward} onAwardTeam={handleBuzzerAwardTeam} />
          )}

          {/* Attribution des points (mode 'buzzer', phase stopped ou results) */}
          {mode === 'buzzer' && (phase === 'stopped' || phase === 'results') && results.length > 0 && (
            <BuzzerPanel rows={results} teams={teams} onAward={handleBuzzerAward} onAwardTeam={handleBuzzerAwardTeam} />
          )}

          {/* Réponses des joueurs (mode 'text', phase stopped ou results) */}
          {mode === 'text' && (phase === 'stopped' || phase === 'results') && results.length > 0 && (
            <div className="bg-gray-800 rounded-2xl p-4 space-y-3">
              <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">
                Réponses {phase === 'results' ? '& points attribués' : '— attribuer les points'}
              </h3>
              <div className="space-y-2">
                {results.map(r => {
                  const awards = roundAwards[r.playerId] || {};
                  return (
                    <div key={r.playerId} className="bg-gray-700/50 rounded-xl p-3">
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-semibold text-white text-sm">{r.playerName}</span>
                        <span className="text-xs text-yellow-400 font-bold">
                          {r.roundPoints > 0 ? `+${r.roundPoints} pt${r.roundPoints > 1 ? 's' : ''}` : ''}
                          <span className="text-gray-400 ml-1">({r.totalScore} total)</span>
                        </span>
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        {/* Artiste */}
                        <div
                          className={`flex items-center justify-between rounded-lg px-2 py-1.5 border transition-colors ${
                            awards.artist
                              ? 'bg-green-900/40 border-green-600/50'
                              : 'bg-gray-600/40 border-gray-600/30'
                          }`}
                        >
                          <div>
                            <p className="text-xs text-gray-400">Artiste</p>
                            <p className="text-sm text-white font-medium">{r.answer.artist || <em className="text-gray-500">vide</em>}</p>
                          </div>
                          {phase === 'stopped' && (
                            <button
                              onClick={() => handleAward(r.playerId, 'artist', !awards.artist)}
                              className={`shrink-0 ml-2 w-7 h-7 rounded-full text-xs font-bold transition-colors ${
                                awards.artist
                                  ? 'bg-green-600 text-white hover:bg-red-600'
                                  : 'bg-gray-500 text-gray-300 hover:bg-green-700'
                              }`}
                            >
                              {awards.artist ? '✓' : '+1'}
                            </button>
                          )}
                        </div>

                        {/* Titre */}
                        <div
                          className={`flex items-center justify-between rounded-lg px-2 py-1.5 border transition-colors ${
                            awards.title
                              ? 'bg-green-900/40 border-green-600/50'
                              : 'bg-gray-600/40 border-gray-600/30'
                          }`}
                        >
                          <div>
                            <p className="text-xs text-gray-400">Titre</p>
                            <p className="text-sm text-white font-medium">{r.answer.title || <em className="text-gray-500">vide</em>}</p>
                          </div>
                          {phase === 'stopped' && (
                            <button
                              onClick={() => handleAward(r.playerId, 'title', !awards.title)}
                              className={`shrink-0 ml-2 w-7 h-7 rounded-full text-xs font-bold transition-colors ${
                                awards.title
                                  ? 'bg-green-600 text-white hover:bg-red-600'
                                  : 'bg-gray-500 text-gray-300 hover:bg-green-700'
                              }`}
                            >
                              {awards.title ? '✓' : '+1'}
                            </button>
                          )}
                        </div>
                      </div>

                      {awards.artist && awards.title && (
                        <p className="text-xs text-yellow-400 mt-1 text-right">Bonus les deux = 3 pts</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Équipes */}
          <TeamManager
            players={players}
            teams={teams}
            onCreateTeam={handleCreateTeam}
            onDeleteTeam={handleDeleteTeam}
            onAssignTeam={handleAssignTeam}
          />

          {/* Classement */}
          <div className="bg-gray-800 rounded-2xl p-4">
            <h3 className="text-xs text-gray-400 uppercase tracking-wide mb-3">
              Joueurs ({players.length})
            </h3>
            {players.length === 0 ? (
              <p className="text-gray-500 text-sm text-center py-2">
                En attente de joueurs… (code : <strong className="font-mono text-white">{roomCode}</strong>)
              </p>
            ) : (
              <Scoreboard players={players} teams={teams} />
            )}
          </div>

          {/* Fin de partie */}
          {gameOver && (
            <div className="bg-violet-900/30 border border-violet-700/40 rounded-2xl p-4 text-center">
              <p className="text-2xl font-bold text-white">Partie terminée !</p>
              <p className="text-violet-300 text-sm mt-1">Classement final affiché ci-dessus.</p>
            </div>
          )}
        </div>
      </div>

      {/* Navigateur de fichiers */}
      {showBrowser && (
        <FileBrowser
          onSelect={handleSelectFile}
          onClose={() => setShowBrowser(false)}
        />
      )}
    </div>
  );
}
