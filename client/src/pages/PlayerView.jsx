import { useState, useEffect, useRef } from 'react';
import PropTypes from 'prop-types';
import socket from '../socket.js';
import Scoreboard from '../components/Scoreboard.jsx';
import { teamColorClasses } from '../teamColors.js';

/**
 * Vue joueur : écoute la musique et soumet ses réponses (mode 'text')
 * ou buzze le plus vite possible (mode 'buzzer').
 *
 * playerInfo   : { name, roomCode }
 * initialState : état initial reçu lors du join
 */
export default function PlayerView({ playerInfo, initialState }) {
  const [phase,        setPhase]        = useState(initialState?.phase        || 'lobby');
  const [mode,         setMode]         = useState(initialState?.mode         || 'text');
  const [players,      setPlayers]      = useState(initialState?.players      || []);
  const [teams,        setTeams]        = useState(initialState?.teams        || []);
  const [masterOnline, setMasterOnline] = useState(initialState?.masterOnline ?? true);
  const [artist,       setArtist]       = useState('');
  const [title,        setTitle]        = useState('');
  const [submitted,    setSubmitted]    = useState(false);
  const [buzzed,       setBuzzed]       = useState(false);
  const [buzzOrder,    setBuzzOrder]    = useState([]);
  const [results,      setResults]      = useState(null);
  const [audioUrl,     setAudioUrl]     = useState('');
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [answerers,    setAnswerers]    = useState(new Set());
  const [gameOver,     setGameOver]     = useState(false);
  const audioRef = useRef(null);

  const myId   = socket.id;
  const me     = players.find(p => p.id === myId);
  const myTeam = me?.teamId ? teams.find(t => t.id === me.teamId) : null;
  const myBuzz = buzzOrder.find(b => b.playerId === myId);

  // ── Neutraliser les contrôles média OS/matériels (touches clavier, casque…) ──
  // Seul le maître du jeu pilote la lecture ; on empêche les joueurs de la couper.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const noop = () => {};
    const actions = ['play', 'pause', 'stop', 'seekto', 'seekbackward', 'seekforward', 'previoustrack', 'nexttrack'];
    for (const action of actions) {
      try { navigator.mediaSession.setActionHandler(action, noop); } catch { /* action non supportée par ce navigateur */ }
    }
  }, []);

  // ── Events socket ──────────────────────────────────────────────────────────
  useEffect(() => {
    function onPlayerJoined(p) {
      setPlayers(prev => {
        if (prev.find(x => x.id === p.id)) return prev;
        return [...prev, p];
      });
    }

    function onPlayerLeft({ playerId }) {
      setPlayers(prev => prev.filter(p => p.id !== playerId));
    }

    function onTrackPlaying({ audioUrl: url }) {
      setAudioUrl(url);
      setPhase('playing');
      setSubmitted(false);
      setBuzzed(false);
      setBuzzOrder([]);
      setAnswerers(new Set());
      setResults(null);
      // Lancer l'audio
      if (audioRef.current) {
        audioRef.current.src = url;
        audioRef.current.load();
        audioRef.current.play()
          .then(() => setAudioBlocked(false))
          .catch(() => setAudioBlocked(true)); // autoplay bloqué — l'utilisateur doit débloquer le son
      }
    }

    function onTrackStopped() {
      setPhase('stopped');
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
      }
    }

    function onSomeoneAnswered({ playerId }) {
      setAnswerers(prev => new Set([...prev, playerId]));
    }

    function onBuzzUpdate({ buzzOrder: order }) {
      setBuzzOrder(order);
      if (order.some(b => b.playerId === myId)) setBuzzed(true);
    }

    function onResultsRevealed(data) {
      setResults(data);
      setPhase('results');
    }

    function onRoundReset() {
      setPhase('lobby');
      setArtist('');
      setTitle('');
      setSubmitted(false);
      setBuzzed(false);
      setBuzzOrder([]);
      setResults(null);
      setAnswerers(new Set());
      setAudioUrl('');
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = '';
      }
    }

    function onGameOver({ scores }) {
      setPlayers(scores);
      setGameOver(true);
      setPhase('results');
    }

    function onState(s) {
      setPhase(s.phase);
      setMode(s.mode);
      setPlayers(s.players);
      setTeams(s.teams || []);
      if (s.masterOnline !== undefined) setMasterOnline(s.masterOnline);
    }

    function onMasterOffline() { setMasterOnline(false); }
    function onMasterOnline()  { setMasterOnline(true);  }

    socket.on('state',            onState);
    socket.on('player-joined',    onPlayerJoined);
    socket.on('player-left',      onPlayerLeft);
    socket.on('track-playing',    onTrackPlaying);
    socket.on('track-stopped',    onTrackStopped);
    socket.on('someone-answered', onSomeoneAnswered);
    socket.on('buzz-update',      onBuzzUpdate);
    socket.on('results-revealed', onResultsRevealed);
    socket.on('round-reset',      onRoundReset);
    socket.on('game-over',        onGameOver);
    socket.on('master-offline',   onMasterOffline);
    socket.on('master-online',    onMasterOnline);

    return () => {
      socket.off('state',            onState);
      socket.off('player-joined',    onPlayerJoined);
      socket.off('player-left',      onPlayerLeft);
      socket.off('track-playing',    onTrackPlaying);
      socket.off('track-stopped',    onTrackStopped);
      socket.off('someone-answered', onSomeoneAnswered);
      socket.off('buzz-update',      onBuzzUpdate);
      socket.off('results-revealed', onResultsRevealed);
      socket.off('round-reset',      onRoundReset);
      socket.off('game-over',        onGameOver);
      socket.off('master-offline',   onMasterOffline);
      socket.off('master-online',    onMasterOnline);
    };
  }, []);

  // ── Soumettre une réponse ──────────────────────────────────────────────────
  function handleSubmit(e) {
    e.preventDefault();
    if (phase !== 'playing') return;
    socket.emit('submit-answer', { artist, title });
    setSubmitted(true);
  }

  // Permettre de re-soumettre (mise à jour de la réponse)
  function handleEdit() {
    setSubmitted(false);
  }

  // ── Débloquer l'audio si l'autoplay a été refusé par le navigateur ─────────
  function handleUnlockAudio() {
    audioRef.current?.play().then(() => setAudioBlocked(false)).catch(() => {});
  }

  // ── Buzzer ──────────────────────────────────────────────────────────────────
  function handleBuzz() {
    if (phase !== 'playing' || buzzed) return;
    socket.emit('buzz');
    setBuzzed(true);
  }

  // ── Mon résultat dans le round ─────────────────────────────────────────────
  const myResult = results?.results?.find(r => r.playerId === myId);

  let buzzButtonLabel = 'BUZZ !';
  if (buzzed) buzzButtonLabel = myBuzz ? `#${myBuzz.order} !` : 'Buzzé !';

  // ── Affichage ──────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex flex-col max-w-lg mx-auto p-3 gap-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <span className="text-xs text-gray-400 uppercase tracking-wide">Partie</span>
          <span className="ml-2 font-mono font-bold text-white text-lg tracking-widest">
            {playerInfo.roomCode}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {myTeam && (
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${teamColorClasses(myTeam.color).badge}`}>
              {myTeam.name}
            </span>
          )}
          <span className="text-sm text-gray-300 font-medium">{playerInfo.name}</span>
          <PhaseBadge phase={phase} />
        </div>
      </div>

      {/* Bandeau MJ hors ligne */}
      {!masterOnline && (
        <div className="bg-orange-900/40 border border-orange-700/50 rounded-xl px-4 py-2 text-sm text-orange-300 text-center animate-pulse">
          Le maître du jeu s'est déconnecté — en attente de reconnexion…
        </div>
      )}

      {/* Lecteur audio — sans contrôles : seul le maître pilote play/pause/skip */}
      <audio ref={audioRef} className="hidden" />

      {phase === 'playing' && (
        <div className="bg-gray-800 rounded-2xl px-4 py-3 flex items-center justify-center">
          {audioBlocked ? (
            <button
              onClick={handleUnlockAudio}
              className="bg-sky-600 hover:bg-sky-500 text-white font-semibold px-4 py-2 rounded-lg text-sm transition-colors"
            >
              🔊 Activer le son
            </button>
          ) : (
            <span className="flex items-center gap-2 text-green-300 text-sm">
              <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" /> Lecture en cours…
            </span>
          )}
        </div>
      )}

      {/* Buzzer — mode 'buzzer' */}
      {mode === 'buzzer' && (phase === 'playing' || phase === 'stopped') && !gameOver && (
        <div className="bg-gray-800 rounded-2xl p-4 space-y-3">
          <button
            onClick={handleBuzz}
            disabled={phase !== 'playing' || buzzed}
            className={`w-full aspect-[3/1] rounded-2xl text-2xl font-extrabold uppercase tracking-widest
                        transition-all active:scale-95 disabled:cursor-not-allowed ${
              buzzed
                ? 'bg-gray-700 text-gray-500'
                : 'bg-red-600 hover:bg-red-500 text-white shadow-lg shadow-red-900/50'
            }`}
          >
            {buzzButtonLabel}
          </button>

          {buzzOrder.length > 0 && (
            <ol className="space-y-1">
              {buzzOrder.map(b => (
                <li
                  key={b.playerId}
                  className={`flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg ${
                    b.playerId === myId ? 'bg-sky-900/40 border border-sky-700/40' : 'bg-gray-700/50'
                  }`}
                >
                  <span className="w-6 text-center shrink-0 text-gray-400">#{b.order}</span>
                  <span className="flex-1 truncate font-medium text-white">{b.playerName}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      {/* Formulaire de réponse — mode 'text' */}
      {mode === 'text' && (phase === 'playing' || phase === 'stopped') && !gameOver && (
        <div className="bg-gray-800 rounded-2xl p-4 space-y-3">
          <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">
            {phase === 'playing' ? 'Ta réponse' : 'La musique est stoppée'}
          </h2>

          {submitted && phase === 'playing' ? (
            <div className="space-y-3">
              <div className="bg-green-900/30 border border-green-700/40 rounded-lg px-4 py-3 text-sm text-green-300">
                Réponse envoyée !
                {artist && <span className="block text-green-200">Artiste : <strong>{artist}</strong></span>}
                {title  && <span className="block text-green-200">Titre : <strong>{title}</strong></span>}
              </div>
              <button
                onClick={handleEdit}
                className="text-xs text-gray-400 hover:text-white underline"
              >
                Modifier ma réponse
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Artiste</label>
                <input
                  type="text"
                  value={artist}
                  onChange={e => setArtist(e.target.value)}
                  disabled={phase !== 'playing'}
                  placeholder="Nom de l'artiste…"
                  className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm
                             text-white placeholder-gray-500 disabled:opacity-50
                             focus:outline-none focus:border-sky-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Titre</label>
                <input
                  type="text"
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  disabled={phase !== 'playing'}
                  placeholder="Titre de la chanson…"
                  className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm
                             text-white placeholder-gray-500 disabled:opacity-50
                             focus:outline-none focus:border-sky-500"
                />
              </div>
              <button
                type="submit"
                disabled={phase !== 'playing' || (!artist.trim() && !title.trim())}
                className="w-full bg-sky-600 hover:bg-sky-500 disabled:bg-gray-600 disabled:cursor-not-allowed
                           text-white font-semibold py-2 rounded-lg transition-colors text-sm"
              >
                Envoyer ma réponse
              </button>
            </form>
          )}

          {/* Indicateur de qui a répondu (phase playing) */}
          {phase === 'playing' && (
            <div className="flex flex-wrap gap-1 pt-1">
              {players.map(p => (
                <span
                  key={p.id}
                  className={`text-xs px-2 py-0.5 rounded-full ${
                    answerers.has(p.id)
                      ? 'bg-green-800/50 text-green-300'
                      : 'bg-gray-700 text-gray-500'
                  }`}
                >
                  {answerers.has(p.id) ? '✓ ' : ''}{p.name}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Résultats du round */}
      {phase === 'results' && results && (
        <div className="bg-gray-800 rounded-2xl p-4 space-y-3">
          {results.metadata && (
            <div className="text-center pb-2 border-b border-gray-700">
              <p className="text-xl font-bold text-white">{results.metadata.title}</p>
              {results.metadata.artist && (
                <p className="text-sky-400">{results.metadata.artist}</p>
              )}
              {results.metadata.album && (
                <p className="text-xs text-gray-400 mt-0.5">
                  {results.metadata.album}{results.metadata.year ? ` · ${results.metadata.year}` : ''}
                </p>
              )}
            </div>
          )}

          {myResult && (
            <div className={`rounded-lg px-3 py-2 text-sm ${
              myResult.roundPoints > 0 ? 'bg-green-900/30 border border-green-700/40' : 'bg-gray-700/50'
            }`}>
              <p className="font-semibold">
                {myResult.roundPoints > 0
                  ? `+${myResult.roundPoints} point${myResult.roundPoints > 1 ? 's' : ''} ce round !`
                  : 'Pas de point ce round'}
              </p>
              <p className="text-xs text-gray-400 mt-0.5">
                Total : <strong>{myResult.totalScore} pts</strong>
              </p>
            </div>
          )}

          <details className="text-xs text-gray-400">
            <summary className="cursor-pointer hover:text-white">
              {mode === 'buzzer' ? 'Voir le classement des buzzs' : 'Voir toutes les réponses'}
            </summary>
            <div className="mt-2 space-y-1">
              {results.results.map(r => (
                <div key={r.playerId} className="flex items-center gap-2">
                  <span className="font-medium text-gray-300 w-24 truncate">{r.playerName}</span>
                  {mode === 'buzzer' ? (
                    <span className="text-gray-500">
                      {r.buzz ? `#${r.buzz.order}` : "N'a pas buzzé"}
                    </span>
                  ) : (
                    <>
                      <span className={r.awards?.artist ? 'text-green-400' : 'text-gray-500'}>
                        {r.answer.artist || '—'}
                      </span>
                      <span className="text-gray-600">·</span>
                      <span className={r.awards?.title ? 'text-green-400' : 'text-gray-500'}>
                        {r.answer.title || '—'}
                      </span>
                    </>
                  )}
                  {r.roundPoints > 0 && (
                    <span className="ml-auto text-yellow-400 font-bold">+{r.roundPoints}</span>
                  )}
                </div>
              ))}
            </div>
          </details>
        </div>
      )}

      {/* Fin de partie */}
      {gameOver && (
        <div className="bg-violet-900/30 border border-violet-700/40 rounded-2xl p-4 text-center">
          <p className="text-2xl font-bold text-white mb-1">Partie terminée !</p>
          <p className="text-violet-300 text-sm">Classement final :</p>
        </div>
      )}

      {/* Classement */}
      <div className="bg-gray-800 rounded-2xl p-4">
        <h3 className="text-xs text-gray-400 uppercase tracking-wide mb-3">Classement</h3>
        <Scoreboard players={players} teams={teams} myId={myId} />
      </div>

      {/* Attente */}
      {phase === 'lobby' && !gameOver && (
        <p className="text-center text-gray-500 text-sm animate-pulse">
          En attente du maître du jeu…
        </p>
      )}
    </div>
  );
}

function PhaseBadge({ phase }) {
  const map = {
    lobby:   { label: 'Attente',   cls: 'bg-gray-700 text-gray-300' },
    playing: { label: 'En cours',  cls: 'bg-green-800/60 text-green-300 animate-pulse' },
    stopped: { label: 'Stoppé',    cls: 'bg-yellow-800/60 text-yellow-300' },
    results: { label: 'Résultats', cls: 'bg-violet-800/60 text-violet-300' },
  };
  const { label, cls } = map[phase] || map.lobby;
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cls}`}>{label}</span>
  );
}

PhaseBadge.propTypes = { phase: PropTypes.string.isRequired };

PlayerView.propTypes = {
  playerInfo: PropTypes.shape({
    name:     PropTypes.string.isRequired,
    roomCode: PropTypes.string.isRequired,
  }).isRequired,
  initialState: PropTypes.shape({
    phase:        PropTypes.string,
    mode:         PropTypes.string,
    players:      PropTypes.array,
    teams:        PropTypes.array,
    masterOnline: PropTypes.bool,
  }),
};

PlayerView.defaultProps = { initialState: null };
