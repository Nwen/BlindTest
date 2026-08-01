import { useState, useEffect, useCallback, useRef } from 'react';
import socket from './socket.js';
import Home       from './pages/Home.jsx';
import MasterView from './pages/MasterView.jsx';
import PlayerView from './pages/PlayerView.jsx';
import pkg from '../package.json';

// Persistance locale de la session (pour les refreshs et les coupures réseau)
const LS_MASTER = 'blindtest_master'; // { roomCode, masterToken }
const LS_PLAYER = 'blindtest_player'; // { roomCode, name, playerId, playerToken }

function loadSession(key) {
  try { return JSON.parse(localStorage.getItem(key)); }
  catch { return null; }
}

function clearSessions() {
  localStorage.removeItem(LS_MASTER);
  localStorage.removeItem(LS_PLAYER);
}

export default function App() {
  const [view,       setView]       = useState('home'); // 'home' | 'master' | 'player'
  const [masterInfo, setMasterInfo] = useState(null);   // { roomCode, masterToken }
  const [playerInfo, setPlayerInfo] = useState(null);   // { roomCode, name, playerId, playerToken }
  const [gameState,  setGameState]  = useState(null);   // état partagé (phase, players, …)
  const [connected,  setConnected]  = useState(socket.connected);
  const [error,      setError]      = useState('');
  // Une session est enregistrée : on tente de la reprendre avant d'afficher l'accueil
  const [restoring,  setRestoring]  = useState(
    () => Boolean(loadSession(LS_MASTER) || loadSession(LS_PLAYER))
  );

  // ── Reprise de session ─────────────────────────────────────────────────────
  // Rejouée à chaque (re)connexion du socket : après une coupure, socket.io revient
  // avec un nouvel id, il faut donc se réinscrire à la partie pour continuer à en
  // faire partie. Côté serveur, l'identité (et donc le score) tient au token, pas au socket.
  const restore = useCallback(() => {
    const master = loadSession(LS_MASTER);
    if (master?.roomCode && master?.masterToken) {
      socket.emit('reconnect-master', master, (res) => {
        setRestoring(false);
        if (res?.ok) {
          setMasterInfo(master);
          setGameState(res.state);
          setView('master');
        } else {
          localStorage.removeItem(LS_MASTER);
          setView(v => (v === 'master' ? 'home' : v));
        }
      });
      return;
    }

    const player = loadSession(LS_PLAYER);
    if (player?.roomCode && player?.playerToken) {
      socket.emit('rejoin-player',
        { roomCode: player.roomCode, playerToken: player.playerToken },
        (res) => {
          setRestoring(false);
          if (res?.ok) {
            setPlayerInfo({ ...player, playerId: res.playerId });
            setGameState(res.state);
            setView('player');
          } else {
            localStorage.removeItem(LS_PLAYER);
            setView(v => (v === 'player' ? 'home' : v));
            // Le délai de grâce a expiré : la place n'est plus réservée
            setError(res?.error === 'Joueur introuvable'
              ? 'Ta place a expiré — rejoins la partie avec ton pseudo.'
              : res?.error || '');
          }
        });
      return;
    }

    setRestoring(false);
  }, []);

  // ── Connexion socket ────────────────────────────────────────────────────────
  const restoreRef = useRef(restore);
  restoreRef.current = restore;

  useEffect(() => {
    function onConnect() {
      setConnected(true);
      restoreRef.current();
    }
    function onDisconnect() { setConnected(false); }

    socket.on('connect',    onConnect);
    socket.on('disconnect', onDisconnect);
    // Socket déjà connecté au montage : 'connect' ne repassera pas
    if (socket.connected) restoreRef.current();

    return () => {
      socket.off('connect',    onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, []);

  // ── Events globaux ─────────────────────────────────────────────────────────
  useEffect(() => {
    const onState = (s) => setGameState(s);
    const onEnded = ({ reason }) => {
      alert(reason);
      setView('home');
      setGameState(null);
      setMasterInfo(null);
      setPlayerInfo(null);
      clearSessions();
    };

    socket.on('state',      onState);
    socket.on('game-ended', onEnded);
    return () => {
      socket.off('state',      onState);
      socket.off('game-ended', onEnded);
    };
  }, []);

  // ── Créer une partie ───────────────────────────────────────────────────────
  const handleCreateGame = useCallback(() => {
    socket.emit('create-game', (res) => {
      if (!res.ok) return setError(res.error || 'Erreur');
      const info = { roomCode: res.roomCode, masterToken: res.masterToken };
      clearSessions();
      localStorage.setItem(LS_MASTER, JSON.stringify(info));
      setPlayerInfo(null);
      setMasterInfo(info);
      setView('master');
    });
  }, []);

  // ── Rejoindre une partie ───────────────────────────────────────────────────
  const handleJoinGame = useCallback((roomCode, name) => {
    setError('');
    socket.emit('join-game', { roomCode, name }, (res) => {
      if (!res.ok) return setError(res.error || 'Erreur');
      const info = {
        roomCode:    res.state.roomCode,
        name,
        playerId:    res.playerId,
        playerToken: res.playerToken,
      };
      clearSessions();
      localStorage.setItem(LS_PLAYER, JSON.stringify(info));
      setMasterInfo(null);
      setPlayerInfo(info);
      setGameState(res.state);
      setView('player');
    });
  }, []);

  // ── Reprendre comme maître (reconnexion manuelle) ──────────────────────────
  const handleRejoinMaster = useCallback((roomCode, masterToken) => {
    setError('');
    socket.emit('reconnect-master', { roomCode, masterToken }, (res) => {
      if (!res.ok) return setError(res.error || 'Code ou token invalide');
      const info = { roomCode, masterToken };
      clearSessions();
      localStorage.setItem(LS_MASTER, JSON.stringify(info));
      setPlayerInfo(null);
      setMasterInfo(info);
      setGameState(res.state);
      setView('master');
    });
  }, []);

  // ── Quitter volontairement (sinon la session est reprise automatiquement) ──
  const handleLeave = useCallback(() => {
    socket.emit('leave-game');
    clearSessions();
    setMasterInfo(null);
    setPlayerInfo(null);
    setGameState(null);
    setError('');
    setView('home');
  }, []);

  // ── Fin de partie décidée par le MJ ─────────────────────────────────────────
  // MasterView a déjà envoyé la commande et attendu la confirmation serveur (qui a
  // aussi notifié les joueurs) ; ici on ne fait que ramener le MJ à l'accueil.
  const handleEndGame = useCallback(() => {
    clearSessions();
    setMasterInfo(null);
    setPlayerInfo(null);
    setGameState(null);
    setError('');
    setView('home');
  }, []);

  const inGame = (view === 'master' && masterInfo) || (view === 'player' && playerInfo);

  // ── Écran d'attente (hors partie uniquement : on ne démonte jamais une partie
  //    en cours, sinon une coupure réseau ferait perdre la saisie et le lecteur) ──
  if (!inGame && (!connected || restoring)) {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-400">
        <div className="text-center space-y-2">
          <div className="text-4xl animate-pulse">...</div>
          <p>{restoring ? 'Reprise de la partie…' : 'Connexion au serveur…'}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900">
      {!connected && (
        <div className="fixed top-0 inset-x-0 z-50 bg-orange-900/90 text-orange-100 text-xs
                        text-center py-1.5 animate-pulse">
          Connexion perdue — reconnexion en cours… (ta place et tes points sont conservés)
        </div>
      )}
      <span className="fixed bottom-1 right-2 text-[10px] text-gray-600 select-none z-50">
        v{pkg.version}
      </span>
      {view === 'home' && (
        <Home
          onCreateGame={handleCreateGame}
          onJoinGame={handleJoinGame}
          onRejoinMaster={handleRejoinMaster}
          error={error}
        />
      )}
      {view === 'master' && masterInfo && (
        <MasterView
          masterInfo={masterInfo}
          initialState={gameState}
          onEndGame={handleEndGame}
        />
      )}
      {view === 'player' && playerInfo && (
        <PlayerView
          playerInfo={playerInfo}
          initialState={gameState}
          onLeave={handleLeave}
        />
      )}
    </div>
  );
}
