'use strict';

const { v4: uuidv4 } = require('uuid');
const { WORDS_8 } = require('./words8');

// ─── Constantes ─────────────────────────────────────────────────────────────

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans 0/O/1/I pour lisibilité

// Délai avant suppression de la partie si le maître ne revient pas (ms)
const MASTER_RECONNECT_GRACE = 5 * 60 * 1000; // 5 minutes

// Délai avant qu'un joueur déconnecté soit réellement retiré de la partie (ms).
// Tant qu'il n'est pas écoulé, le joueur reste dans la partie avec son score, son
// équipe et ses réponses : un refresh, un passage en veille ou une coupure réseau
// ne lui coûte rien.
const PLAYER_RECONNECT_GRACE = 15 * 60 * 1000; // 15 minutes

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

    // Partie terminée (playlist épuisée) — distinct de la phase 'results' d'un round
    this.over = false;

    // Mode de jeu : 'text' (réponse écrite) | 'buzzer' (réaction + points manuels)
    this.mode = 'text';

    // playerId (identifiant stable, indépendant du socket) →
    //   { id, token, name, score, teamId, connected, socketId, reconnectTimer }
    this.players = new Map();

    // socketId → playerId  (un joueur change de socketId à chaque reconnexion)
    this.socketToPlayer = new Map();

    // teamId → { id, name, color }
    this.teams = new Map();

    // Liste de pistes : TrackInfo[]
    this.playlist = [];

    this.currentTrackIndex = -1;

    // playerId → { artist, title, submittedAt }  (mode 'text')
    this.answers = new Map();

    // Liste des buzzs du round : { playerId, teamId, order, at, reactionMs }[]  (mode 'buzzer')
    // Un tableau (et non une Map) car un joueur en équipe peut buzzer plusieurs fois
    // (buzz bonus accordé aux équipes plus petites, voir _teamBuzzBudget).
    this.buzzes = [];

    // Horodatage du lancement de la piste courante (référence pour le temps de réaction)
    this.trackStartedAt = null;

    // Mode 'buzzer' : musique en pause suite à un buzz, en attente que le maître reprenne
    this.paused = false;
    // Début de la pause en cours, et cumul des pauses depuis le lancement de la piste :
    // permet de connaître la position de lecture exacte pour resynchroniser un joueur
    // qui revient en cours de morceau.
    this.pausedAt      = null;
    this.pausedTotalMs = 0;

    // Mode 'text'  : playerId → { artist: bool, title: bool }
    // Mode 'buzzer': playerId → nombre de points attribués ce round
    // — attribués par le maître
    this.roundAwards = new Map();
  }

  // ── Joueurs ────────────────────────────────────────────────────────────────

  addPlayer(socketId, name) {
    const player = {
      id:        uuidv4(), // stable pour toute la partie, contrairement au socketId
      token:     uuidv4(), // secret conservé côté client pour se reconnecter
      name,
      score:     0,
      teamId:    null,
      connected: true,
      socketId,
      reconnectTimer: null,
    };
    this.players.set(player.id, player);
    this.socketToPlayer.set(socketId, player.id);
    return player;
  }

  getPlayerBySocket(socketId) {
    const playerId = this.socketToPlayer.get(socketId);
    return playerId ? this.players.get(playerId) || null : null;
  }

  findPlayerByToken(token) {
    if (!token) return null;
    for (const player of this.players.values()) {
      if (player.token === token) return player;
    }
    return null;
  }

  findPlayerByName(name) {
    const wanted = (name || '').trim().toLowerCase();
    if (!wanted) return null;
    for (const player of this.players.values()) {
      if (player.name.toLowerCase() === wanted) return player;
    }
    return null;
  }

  /** Rattache un joueur existant à un nouveau socket (refresh, coupure réseau, reprise de pseudo). */
  attachSocket(player, socketId) {
    if (player.reconnectTimer) {
      clearTimeout(player.reconnectTimer);
      player.reconnectTimer = null;
    }
    if (player.socketId) this.socketToPlayer.delete(player.socketId);
    player.socketId  = socketId;
    player.connected = true;
    this.socketToPlayer.set(socketId, player.id);
    return player;
  }

  /**
   * Marque le joueur hors ligne sans rien perdre (score, équipe, réponses, buzzs).
   * Il n'est réellement retiré de la partie qu'une fois le délai de grâce écoulé,
   * et `onExpire` est alors appelé.
   */
  detachSocket(socketId, onExpire) {
    const player = this.getPlayerBySocket(socketId);
    if (!player) return null;

    this.socketToPlayer.delete(socketId);
    player.socketId  = null;
    player.connected = false;
    player.reconnectTimer = setTimeout(() => {
      player.reconnectTimer = null;
      this.removePlayer(player.id);
      onExpire?.(player);
    }, PLAYER_RECONNECT_GRACE);

    return player;
  }

  removePlayer(playerId) {
    const player = this.players.get(playerId);
    if (!player) return false;

    if (player.reconnectTimer) clearTimeout(player.reconnectTimer);
    if (player.socketId) this.socketToPlayer.delete(player.socketId);
    this.players.delete(playerId);
    this.answers.delete(playerId);
    this.roundAwards.delete(playerId);
    this.buzzes = this.buzzes.filter(b => b.playerId !== playerId);
    return true;
  }

  /** Joueurs actuellement connectés (les hors ligne gardent leurs points mais ne jouent pas). */
  connectedPlayers() {
    return Array.from(this.players.values()).filter(p => p.connected);
  }

  /** Libère les timers en attente — appelé quand la partie est supprimée. */
  destroy() {
    if (this.masterReconnectTimer) clearTimeout(this.masterReconnectTimer);
    this.masterReconnectTimer = null;
    for (const player of this.players.values()) {
      if (player.reconnectTimer) clearTimeout(player.reconnectTimer);
      player.reconnectTimer = null;
    }
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
        players: members.map(p => ({
          id:        p.id,
          name:      p.name,
          score:     this.getDisplayScore(p.id),
          connected: p.connected,
        })),
        score:   members.reduce((sum, p) => sum + this.getDisplayScore(p.id), 0),
      };
    });
  }

  /** Points totaux affichés en temps réel (base + round en cours) */
  getDisplayScore(playerId) {
    const player = this.players.get(playerId);
    if (!player) return 0;
    return player.score + this._roundPoints(playerId);
  }

  // ── Lecture ────────────────────────────────────────────────────────────────

  /** Démarre le chronomètre de lecture d'une piste (référence des temps de réaction). */
  startPlayback() {
    this.trackStartedAt = Date.now();
    this.paused         = false;
    this.pausedAt       = null;
    this.pausedTotalMs  = 0;
  }

  /** Retourne true si la pause a effectivement été déclenchée. */
  pausePlayback() {
    if (this.paused) return false;
    this.paused   = true;
    this.pausedAt = Date.now();
    return true;
  }

  /** Retourne true si la lecture a effectivement repris. */
  resumePlayback() {
    if (!this.paused) return false;
    if (this.pausedAt !== null) this.pausedTotalMs += Date.now() - this.pausedAt;
    this.paused   = false;
    this.pausedAt = null;
    return true;
  }

  stopPlayback() {
    if (this.paused && this.pausedAt !== null) this.pausedTotalMs += Date.now() - this.pausedAt;
    this.paused   = false;
    this.pausedAt = null;
  }

  /**
   * Position de lecture courante de la piste, pauses déduites (ms).
   * Sert à resynchroniser un joueur qui revient en cours de morceau : il reprend
   * là où en sont les autres au lieu de réécouter l'intro.
   */
  getPlaybackPositionMs() {
    if (this.trackStartedAt === null) return 0;
    const ref = this.paused && this.pausedAt !== null ? this.pausedAt : Date.now();
    return Math.max(0, ref - this.trackStartedAt - this.pausedTotalMs);
  }

  // ── Round ──────────────────────────────────────────────────────────────────

  resetRound() {
    this.answers.clear();
    this.roundAwards.clear();
    this.buzzes = [];
    this.trackStartedAt = null;
    this.paused         = false;
    this.pausedAt       = null;
    this.pausedTotalMs  = 0;
  }

  submitAnswer(playerId, { artist, title }) {
    this.answers.set(playerId, {
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
   * Nombre de buzzs qu'une équipe peut effectuer sur le round : un par membre connecté,
   * plus des buzzs bonus pour égaliser avec la plus grande équipe (ex : 3 vs 2 → l'équipe
   * de 2 obtient un buzz bonus pour arriver à 3, comme l'équipe de 3).
   * Les joueurs hors ligne ne comptent pas : ils ne peuvent pas buzzer, leur équipe ne
   * doit donc ni gagner de budget ni rester bloquée à les attendre.
   */
  _teamBuzzBudget(teamId) {
    const sizes = new Map(); // teamId → nombre de membres connectés
    for (const p of this.connectedPlayers()) {
      if (p.teamId) sizes.set(p.teamId, (sizes.get(p.teamId) || 0) + 1);
    }
    if (!sizes.has(teamId)) return 0;
    return Math.max(...sizes.values());
  }

  /**
   * Enregistre le buzz d'un joueur.
   * Joueur libre (hors équipe) : un seul buzz.
   * Joueur en équipe : un buzz par membre, plus les buzzs bonus (_teamBuzzBudget) qui ne
   * peuvent être utilisés qu'une fois que tous les coéquipiers ont déjà buzzé une fois.
   * Retourne l'entrée créée, ou null si le buzz est refusé.
   */
  registerBuzz(playerId) {
    const player = this.players.get(playerId);
    if (!player) return null;

    if (player.teamId) {
      const teamEntries = this.buzzes.filter(e => e.teamId === player.teamId);
      const budget       = this._teamBuzzBudget(player.teamId);
      if (teamEntries.length >= budget) return null; // équipe à court de buzzs

      const hasAlreadyBuzzed  = teamEntries.some(e => e.playerId === playerId);
      const teammateIds       = this.connectedPlayers()
        .filter(p => p.teamId === player.teamId)
        .map(p => p.id);
      const allTeammatesBuzzed = teammateIds.every(id => teamEntries.some(e => e.playerId === id));

      // Un re-buzz (bonus) n'est possible que quand toute l'équipe a déjà buzzé une fois.
      if (hasAlreadyBuzzed && !allTeammatesBuzzed) return null;
    } else if (this.buzzes.some(e => e.playerId === playerId)) {
      return null; // joueur libre : un seul buzz
    }

    const order = this.buzzes.length + 1;
    const at    = Date.now();
    const entry = {
      playerId,
      teamId:     player.teamId || null,
      order,
      at,
      reactionMs: this.trackStartedAt !== null ? at - this.trackStartedAt : null,
    };
    this.buzzes.push(entry);
    return entry;
  }

  /** Classement des buzzs pour le round en cours (ordre d'arrivée). */
  getLiveBuzzOrder() {
    return [...this.buzzes]
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

  _roundPoints(playerId) {
    const a = this.roundAwards.get(playerId);
    if (this.mode === 'buzzer') {
      return typeof a === 'number' ? a : 0;
    }
    if (!a) return 0;
    if (a.artist && a.title) return 3;
    if (a.artist || a.title) return 1;
    return 0;
  }

  /** Ajuste manuellement le score total d'un joueur (indépendamment du round en cours). */
  adjustScore(playerId, delta) {
    const player = this.players.get(playerId);
    if (!player) throw new Error('Joueur introuvable');
    player.score = Math.max(0, player.score + (Number(delta) || 0));
  }

  /** Valide les points du round en cours et les ajoute au score total. */
  commitRound() {
    for (const [playerId, player] of this.players) {
      player.score += this._roundPoints(playerId);
    }
    // On vide les awards pour éviter le double-comptage si getDisplayScore est appelé après
    this.roundAwards.clear();
  }

  // ── États sérialisables ────────────────────────────────────────────────────

  getPlayerList() {
    return Array.from(this.players.values()).map(p => ({
      id:        p.id,
      name:      p.name,
      score:     this.getDisplayScore(p.id),
      teamId:    p.teamId || null,
      connected: p.connected,
    }));
  }

  /** Résultats complets du round (pour le maître + résultats révélés) */
  getRoundResults() {
    const rows = [];
    for (const [playerId, player] of this.players) {
      // Premier buzz du joueur (s'il en a fait plusieurs grâce à un buzz bonus d'équipe)
      const buzz = this.buzzes.find(e => e.playerId === playerId) || null;
      const row = {
        playerId,
        playerName:    player.name,
        teamId:        player.teamId || null,
        connected:     player.connected,
        roundPoints:   this._roundPoints(playerId),
        totalScore:    this.getDisplayScore(playerId),
      };
      if (this.mode === 'buzzer') {
        row.buzz          = buzz ? { order: buzz.order, reactionMs: buzz.reactionMs } : null;
        row.awardedPoints = this._roundPoints(playerId);
      } else {
        row.answer = this.answers.get(playerId) || { artist: '', title: '' };
        row.awards = this.roundAwards.get(playerId) || { artist: false, title: false };
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
      over:              this.over,
      mode:              this.mode,
      masterOnline:      this.masterOnline,
      players:           this.getPlayerList(),
      teams:             this.getTeamList(),
      currentTrackIndex: this.currentTrackIndex,
      playlistLength:    this.playlist.length,
      paused:            this.paused,
    };
  }

  /** État complet envoyé au maître */
  getMasterState() {
    return {
      roomCode:          this.id,
      masterToken:       this.masterToken,
      phase:             this.phase,
      over:              this.over,
      mode:              this.mode,
      players:           this.getPlayerList(),
      teams:             this.getTeamList(),
      playlist:          this.playlist,
      currentTrackIndex: this.currentTrackIndex,
      answers:           Object.fromEntries(this.answers),
      roundAwards:       Object.fromEntries(this.roundAwards),
      buzzOrder:         this.getLiveBuzzOrder(),
      paused:            this.paused,
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

  deleteGame(roomCode) {
    const game = this.games.get(roomCode);
    if (!game) return false;
    game.destroy();
    this.games.delete(roomCode);
    // Sans ça, les sockets encore en jeu (joueurs, MJ) restent mappés vers un code de
    // room qui n'existe plus — inoffensif tant que le code n'est pas régénéré pour une
    // nouvelle partie, mais autant nettoyer tout de suite.
    for (const [socketId, code] of this.socketToRoom) {
      if (code === roomCode) this.socketToRoom.delete(socketId);
    }
    return true;
  }

  /**
   * Rejoint une partie par pseudo. Si un joueur hors ligne porte déjà ce pseudo,
   * on lui rend sa place (score, équipe, réponses) au lieu d'en créer un nouveau :
   * c'est le filet de sécurité quand le joueur a perdu son token (autre appareil,
   * navigation privée, cache vidé).
   */
  joinGame(roomCode, socketId, name) {
    const game = this.getGame(roomCode);
    if (!game) throw new Error('Partie introuvable');

    const trimmed = (name || '').trim();
    if (!trimmed) throw new Error('Pseudo invalide');

    const existing = game.findPlayerByName(trimmed);
    if (existing) {
      if (existing.connected) throw new Error('Ce pseudo est déjà pris');
      game.attachSocket(existing, socketId);
      this.socketToRoom.set(socketId, game.id);
      return { game, player: existing, reclaimed: true };
    }

    if (game.phase === 'results') throw new Error('La partie est terminée');

    const player = game.addPlayer(socketId, trimmed);
    this.socketToRoom.set(socketId, game.id);
    return { game, player, reclaimed: false };
  }

  /** Reconnexion d'un joueur via son token (refresh, coupure réseau, retour d'onglet). */
  rejoinPlayer(roomCode, socketId, playerToken) {
    const game = this.getGame(roomCode);
    if (!game) throw new Error('Partie introuvable');

    const player = game.findPlayerByToken(playerToken);
    if (!player) throw new Error('Joueur introuvable');

    game.attachSocket(player, socketId);
    this.socketToRoom.set(socketId, game.id);
    return { game, player };
  }

  /** Départ volontaire d'un joueur : suppression immédiate, sans délai de grâce. */
  quitGame(socketId) {
    const game = this.getGameBySocket(socketId);
    if (!game) return null;

    const player = game.getPlayerBySocket(socketId);
    if (!player) return null; // le maître ne quitte pas par ce chemin

    this.socketToRoom.delete(socketId);
    game.removePlayer(player.id);
    return { game, player };
  }

  leaveGame(socketId, onPlayerExpired) {
    const game = this.getGameBySocket(socketId);
    if (!game) return null;

    this.socketToRoom.delete(socketId);

    if (game.masterId === socketId) {
      // Ne pas supprimer la partie immédiatement : laisser 5 minutes au MJ pour revenir
      game.masterId     = null;
      game.masterOnline = false;
      game.masterReconnectTimer = setTimeout(() => {
        game.masterReconnectTimer = null;
        this.deleteGame(game.id);
      }, MASTER_RECONNECT_GRACE);
      return { game, masterLeft: true, player: null };
    }

    // Le joueur n'est pas retiré : il passe hors ligne et garde tout jusqu'à
    // l'expiration du délai de grâce.
    const player = game.detachSocket(socketId, p => onPlayerExpired?.(game, p));
    return { game, masterLeft: false, player };
  }
}

GameManager.MASTER_RECONNECT_GRACE = MASTER_RECONNECT_GRACE;
GameManager.PLAYER_RECONNECT_GRACE = PLAYER_RECONNECT_GRACE;

module.exports = GameManager;
