'use strict';

const { v4: uuidv4 } = require('uuid');
const { WORDS_8 } = require('./words8');

// ─── Constantes ─────────────────────────────────────────────────────────────

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans 0/O/1/I pour lisibilité

// Délai avant suppression de la partie si le maître ne revient pas (ms)
const MASTER_RECONNECT_GRACE = 5 * 60 * 1000; // 5 minutes

// Modes de jeu disponibles
const GAME_MODES = new Set(['text', 'buzzer']);

// Palette cyclique attribuée aux équipes (noms mappés à des classes Tailwind côté client)
const TEAM_COLORS = ['sky', 'emerald', 'amber', 'rose', 'violet', 'orange', 'cyan', 'pink'];

function generateCode(len = 6) {
  let code = '';
  for (let i = 0; i < len; i++) code += CHARS[Math.floor(Math.random() * CHARS.length)];
  return code;
}

// Choisit un mot anglais de 8 lettres au hasard, pour un code maître mémorisable.
function generateWordToken() {
  return WORDS_8[Math.floor(Math.random() * WORDS_8.length)];
}

// ─── Classe Game ──────────────────────────────────────────────────────────────

class Game {
  constructor(masterSocketId) {
    this.id          = generateCode(4);
    // Mot de 8 lettres que le maître peut noter pour se reconnecter manuellement
    this.masterToken = generateWordToken();
    this.masterId    = masterSocketId;
    this.masterOnline        = true;
    this.masterReconnectTimer = null; // setTimeout handle

    // Phases : lobby | playing | stopped | results
    this.phase = 'lobby';

    // Mode de jeu : 'text' (réponse écrite) | 'buzzer' (réaction + points manuels)
    this.mode = 'text';

    // socketId → { id, name, score, teamId }
    this.players = new Map();

    // teamId → { id, name, color }
    this.teams = new Map();

    // Liste de pistes : TrackInfo[]
    this.playlist = [];

    this.currentTrackIndex = -1;

    // socketId → { artist, title, submittedAt }  (mode 'text')
    this.answers = new Map();

    // socketId → { order, teamId, at, reactionMs }  (mode 'buzzer')
    this.buzzes = new Map();

    // Horodatage du lancement de la piste courante (référence pour le temps de réaction)
    this.trackStartedAt = null;

    // Mode 'text'  : socketId → { artist: bool, title: bool }
    // Mode 'buzzer': socketId → nombre de points attribués ce round
    // — attribués par le maître
    this.roundAwards = new Map();
  }

  // ── Joueurs ────────────────────────────────────────────────────────────────

  addPlayer(socketId, name) {
    this.players.set(socketId, { id: socketId, name, score: 0, teamId: null });
  }

  removePlayer(socketId) {
    this.players.delete(socketId);
  }

  // ── Mode de jeu ────────────────────────────────────────────────────────────

  setMode(mode) {
    if (!GAME_MODES.has(mode)) throw new Error('Mode de jeu invalide');
    this.mode = mode;
  }

  // ── Équipes ────────────────────────────────────────────────────────────────

  createTeam(name) {
    const id = uuidv4();
    const color = TEAM_COLORS[this.teams.size % TEAM_COLORS.length];
    const team = { id, name: (name || '').trim() || `Équipe ${this.teams.size + 1}`, color };
    this.teams.set(id, team);
    return team;
  }

  deleteTeam(teamId) {
    if (!this.teams.has(teamId)) return false;
    this.teams.delete(teamId);
    for (const player of this.players.values()) {
      if (player.teamId === teamId) player.teamId = null;
    }
    return true;
  }

  /** teamId === null retire le joueur de son équipe */
  assignPlayerTeam(playerId, teamId) {
    const player = this.players.get(playerId);
    if (!player) throw new Error('Joueur introuvable');
    if (teamId !== null && !this.teams.has(teamId)) throw new Error('Équipe introuvable');
    player.teamId = teamId;
  }

  getTeamList() {
    return Array.from(this.teams.values()).map(t => {
      const members = Array.from(this.players.values()).filter(p => p.teamId === t.id);
      return {
        id:      t.id,
        name:    t.name,
        color:   t.color,
        players: members.map(p => ({ id: p.id, name: p.name, score: this.getDisplayScore(p.id) })),
        score:   members.reduce((sum, p) => sum + this.getDisplayScore(p.id), 0),
      };
    });
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
    this.buzzes.clear();
    this.trackStartedAt = null;
  }

  submitAnswer(socketId, { artist, title }) {
    this.answers.set(socketId, {
      artist: (artist || '').trim(),
      title:  (title  || '').trim(),
      submittedAt: Date.now(),
    });
  }

  /**
   * Bascule un award pour un joueur (mode 'text').
   * field : 'artist' | 'title'
   * value : bool
   */
  setAward(playerId, field, value) {
    const awards = this.roundAwards.get(playerId) || { artist: false, title: false };
    awards[field] = value;
    this.roundAwards.set(playerId, awards);
  }

  /** Attribue un nombre de points à un joueur (mode 'buzzer'). */
  setBuzzerPoints(playerId, points) {
    if (!this.players.has(playerId)) throw new Error('Joueur introuvable');
    this.roundAwards.set(playerId, Math.max(0, Number(points) || 0));
  }

  /** Attribue le même nombre de points à tous les membres d'une équipe (mode 'buzzer'). */
  setBuzzerPointsForTeam(teamId, points) {
    if (!this.teams.has(teamId)) throw new Error('Équipe introuvable');
    for (const player of this.players.values()) {
      if (player.teamId === teamId) this.setBuzzerPoints(player.id, points);
    }
  }

  /**
   * Enregistre le buzz d'un joueur. Ignoré si le joueur (ou son équipe) a déjà buzzé.
   * Retourne l'entrée créée, ou null si le buzz est ignoré.
   */
  registerBuzz(socketId) {
    if (this.buzzes.has(socketId)) return null;
    const player = this.players.get(socketId);
    if (!player) return null;

    // Le buzzer d'une équipe se verrouille dès qu'un de ses membres a buzzé.
    if (player.teamId) {
      for (const entry of this.buzzes.values()) {
        if (entry.teamId === player.teamId) return null;
      }
    }

    const order = this.buzzes.size + 1;
    const at    = Date.now();
    const entry = {
      playerId:   socketId,
      teamId:     player.teamId || null,
      order,
      at,
      reactionMs: this.trackStartedAt !== null ? at - this.trackStartedAt : null,
    };
    this.buzzes.set(socketId, entry);
    return entry;
  }

  /** Classement des buzzs pour le round en cours (ordre d'arrivée). */
  getLiveBuzzOrder() {
    return Array.from(this.buzzes.values())
      .sort((a, b) => a.order - b.order)
      .map(b => {
        const player = this.players.get(b.playerId);
        const team   = b.teamId ? this.teams.get(b.teamId) : null;
        return {
          playerId:   b.playerId,
          playerName: player?.name || '?',
          teamId:     b.teamId,
          teamName:   team?.name || null,
          order:      b.order,
          reactionMs: b.reactionMs,
        };
      });
  }

  _roundPoints(socketId) {
    const a = this.roundAwards.get(socketId);
    if (this.mode === 'buzzer') {
      return typeof a === 'number' ? a : 0;
    }
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
      id:     p.id,
      name:   p.name,
      score:  this.getDisplayScore(p.id),
      teamId: p.teamId || null,
    }));
  }

  /** Résultats complets du round (pour le maître + résultats révélés) */
  getRoundResults() {
    const rows = [];
    for (const [socketId, player] of this.players) {
      const buzz = this.buzzes.get(socketId) || null;
      const row = {
        playerId:      socketId,
        playerName:    player.name,
        teamId:        player.teamId || null,
        roundPoints:   this._roundPoints(socketId),
        totalScore:    this.getDisplayScore(socketId),
      };
      if (this.mode === 'buzzer') {
        row.buzz          = buzz ? { order: buzz.order, reactionMs: buzz.reactionMs } : null;
        row.awardedPoints = this._roundPoints(socketId);
      } else {
        row.answer = this.answers.get(socketId) || { artist: '', title: '' };
        row.awards = this.roundAwards.get(socketId) || { artist: false, title: false };
      }
      rows.push(row);
    }

    if (this.mode === 'buzzer') {
      return rows.sort((a, b) => {
        if (a.buzz && b.buzz) return a.buzz.order - b.buzz.order;
        if (a.buzz) return -1;
        if (b.buzz) return 1;
        return b.totalScore - a.totalScore;
      });
    }
    return rows.sort((a, b) => b.totalScore - a.totalScore);
  }

  /** État minimal envoyé aux joueurs */
  getPlayerState() {
    return {
      roomCode:          this.id,
      phase:             this.phase,
      mode:              this.mode,
      masterOnline:      this.masterOnline,
      players:           this.getPlayerList(),
      teams:             this.getTeamList(),
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
      mode:              this.mode,
      players:           this.getPlayerList(),
      teams:             this.getTeamList(),
      playlist:          this.playlist,
      currentTrackIndex: this.currentTrackIndex,
      answers:           Object.fromEntries(this.answers),
      roundAwards:       Object.fromEntries(this.roundAwards),
      buzzOrder:         this.getLiveBuzzOrder(),
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
