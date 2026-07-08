import { useState, useEffect, useCallback } from 'react';
import socket from './socket.js';
import Home       from './pages/Home.jsx';
import MasterView from './pages/MasterView.jsx';
import PlayerView from './pages/PlayerView.jsx';

// Persistance locale du rôle maître (pour les refreshs)
const LS_MASTER = 'blindtest_master';

function loadSavedMaster() {
  try { return JSON.parse(localStorage.getItem(LS_MASTER)); }
  catch { return null; }
}

export default function App() {
  const [view,       setView]       = useState('home'); // 'home' | 'master' | 'player'
  const [masterInfo, setMasterInfo] = useState(null);   // { roomCode, masterToken }
  const [playerInfo, setPlayerInfo] = useState(null);   // { name, roomCode }
  const [gameState,  setGameState]  = useState(null);   // état partagé (phase, players, …)
  const [connected,  setConnected]  = useState(socket.connected);
  const [error,      setError]      = useState('');

  // ── Connexion socket ────────────────────────────────────────────────────────
  useEffect(() => {
    socket.on('connect',    () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    // Tentative de reconnexion en tant que maître après refresh
    const saved = loadSavedMaster();
    if (saved) {
      socket.emit('reconnect-master', saved, (res) => {
        if (res.ok) {
          setMasterInfo(saved);
          setGameState(res.state);
          setView('master');
        } else {
          localStorage.removeItem(LS_MASTER);
        }
      });
    }

    return () => {
      socket.off('connect');
      socket.off('disconnect');
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
      localStorage.removeItem(LS_MASTER);
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
      setMasterInfo(info);
      setView('master');
      localStorage.setItem(LS_MASTER, JSON.stringify(info));
    });
  }, []);

  // ── Rejoindre une partie ───────────────────────────────────────────────────
  const handleJoinGame = useCallback((roomCode, name) => {
    setError('');
    socket.emit('join-game', { roomCode, name }, (res) => {
      if (!res.ok) return setError(res.error || 'Erreur');
      setPlayerInfo({ name, roomCode: res.state.roomCode });
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
      setMasterInfo(info);
      setGameState(res.state);
      setView('master');
      localStorage.setItem(LS_MASTER, JSON.stringify(info));
    });
  }, []);

  // ── Bandeau de connexion ───────────────────────────────────────────────────
  if (!connected) {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-400">
        <div className="text-center space-y-2">
          <div className="text-4xl animate-pulse">...</div>
          <p>Connexion au serveur…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900">
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
        />
      )}
      {view === 'player' && playerInfo && (
        <PlayerView
          playerInfo={playerInfo}
          initialState={gameState}
        />
      )}
    </div>
  );
}
