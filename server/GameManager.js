'use strict';

// ─── Constantes ─────────────────────────────────────────────────────────────

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans 0/O/1/I pour lisibilité

// Délai avant suppression de la partie si le maître ne revient pas (ms)
const MASTER_RECONNECT_GRACE = 5 * 60 * 1000; // 5 minutes

function generateCode(len = 6) {
  let code = '';
  for (let i = 0; i < len; i++) code += CHARS[Math.floor(Math.random() * CHARS.length)];
  return code;
}

// ─── Classe Game ──────────────────────────────────────────────────────────────

class Game {
  constructor(masterSocketId) {
    this.id          = generateCode(4);
    // Code court (8 chars) que le maître peut noter pour se reconnecter manuellement
    this.masterToken = generateCode(8);
    this.masterId    = masterSocketId;
    this.masterOnline        = true;
    this.masterReconnectTimer = null; // setTimeout handle

    // Phases : lobby | playing | stopped | results
    this.phase = 'lobby';

    // socketId → { id, name, score }
    this.players = new Map();

    // Liste de pistes : TrackInfo[]
    this.playlist = [];

    this.currentTrackIndex = -1;

    // socketId → { artist, title, submittedAt }
    this.answers = new Map();

    // socketId → { artist: bool, title: bool }  — attribués par le maître
    this.roundAwards = new Map();
  }

  // ── Joueurs ────────────────────────────────────────────────────────────────

  addPlayer(socketId, name) {
    this.players.set(socketId, { id: socketId, name, score: 0 });
  }

  removePlayer(socketId) {
    this.players.delete(socketId);
  }

  /** Points totaux affichés en temps réel (base + round en cours) */
  getDisplayScore(socketId) {
    const player = this.players.get(socketId);
    if (!player) return 0;
    return player.score + this._roundPoints(socketId);
  }

  // ── Round ──────────────────────────────────────────────────────────────────

  resetRound() {
    this.answers.clear();
    this.roundAwards.clear();
  }

  submitAnswer(socketId, { artist, title }) {
    this.answers.set(socketId, {
      artist: (artist || '').trim(),
      title:  (title  || '').trim(),
      submittedAt: Date.now(),
    });
  }

  /**
   * Bascule un award pour un joueur.
   * field : 'artist' | 'title'
   * value : bool
   */
  setAward(playerId, field, value) {
    const awards = this.roundAwards.get(playerId) || { artist: false, title: false };
    awards[field] = value;
    this.roundAwards.set(playerId, awards);
  }

  _roundPoints(socketId) {
    const a = this.roundAwards.get(socketId);
    if (!a) return 0;
    if (a.artist && a.title) return 3;
    if (a.artist || a.title) return 1;
    return 0;
  }

  /** Valide les points du round en cours et les ajoute au score total. */
  commitRound() {
    for (const [socketId, player] of this.players) {
      player.score += this._roundPoints(socketId);
    }
    // On vide les awards pour éviter le double-comptage si getDisplayScore est appelé après
    this.roundAwards.clear();
  }

  // ── États sérialisables ────────────────────────────────────────────────────

  getPlayerList() {
    return Array.from(this.players.values()).map(p => ({
      id:    p.id,
      name:  p.name,
      score: this.getDisplayScore(p.id),
    }));
  }

  /** Résultats complets du round (pour le maître + résultats révélés) */
  getRoundResults() {
    const rows = [];
    for (const [socketId, player] of this.players) {
      const answer = this.answers.get(socketId) || { artist: '', title: '' };
      const awards = this.roundAwards.get(socketId) || { artist: false, title: false };
      rows.push({
        playerId:    socketId,
        playerName:  player.name,
        answer,
        awards,
        roundPoints: this._roundPoints(socketId),
        totalScore:  this.getDisplayScore(socketId),
      });
    }
    return rows.sort((a, b) => b.totalScore - a.totalScore);
  }

  /** État minimal envoyé aux joueurs */
  getPlayerState() {
    return {
      roomCode:          this.id,
      phase:             this.phase,
      masterOnline:      this.masterOnline,
      players:           this.getPlayerList(),
      currentTrackIndex: this.currentTrackIndex,
      playlistLength:    this.playlist.length,
    };
  }

  /** État complet envoyé au maître */
  getMasterState() {
    return {
      roomCode:          this.id,
      masterToken:       this.masterToken,
      phase:             this.phase,
      players:           this.getPlayerList(),
      playlist:          this.playlist,
      currentTrackIndex: this.currentTrackIndex,
      answers:           Object.fromEntries(this.answers),
      roundAwards:       Object.fromEntries(this.roundAwards),
    };
  }
}

// ─── Classe GameManager ───────────────────────────────────────────────────────

class GameManager {
  constructor() {
    // roomCode → Game
    this.games = new Map();
    // socketId → roomCode
    this.socketToRoom = new Map();
  }

  createGame(masterSocketId) {
    const game = new Game(masterSocketId);
    this.games.set(game.id, game);
    this.socketToRoom.set(masterSocketId, game.id);
    return game;
  }

  getGame(roomCode) {
    return this.games.get((roomCode || '').toUpperCase());
  }

  getGameBySocket(socketId) {
    const code = this.socketToRoom.get(socketId);
    return code ? this.games.get(code) : null;
  }

  joinGame(roomCode, socketId, name) {
    const game = this.getGame(roomCode);
    if (!game) throw new Error('Partie introuvable');
    if (game.phase === 'results') throw new Error('La partie est terminée');

    for (const [, p] of game.players) {
      if (p.name.toLowerCase() === name.trim().toLowerCase()) {
        throw new Error('Ce pseudo est déjà pris');
      }
    }

    game.addPlayer(socketId, name.trim());
    this.socketToRoom.set(socketId, game.id);
    return game;
  }

  leaveGame(socketId) {
    const game = this.getGameBySocket(socketId);
    if (!game) return null;

    this.socketToRoom.delete(socketId);

    if (game.masterId === socketId) {
      // Ne pas supprimer la partie immédiatement : laisser 5 minutes au MJ pour revenir
      game.masterId     = null;
      game.masterOnline = false;
      game.masterReconnectTimer = setTimeout(() => {
        this.games.delete(game.id);
      }, MASTER_RECONNECT_GRACE);
      return { game, masterLeft: true };
    }

    game.removePlayer(socketId);
    return { game, masterLeft: false };
  }
}

module.exports = GameManager;
