'use strict';

const express = require('express');
const http    = require('node:http');
const { Server } = require('socket.io');
const path    = require('node:path');
const fs      = require('node:fs');
const { v4: uuidv4 } = require('uuid');

const GameManager = require('./GameManager');
const mediaRouter  = require('./routes/media');
const youtubeModule = require('./routes/youtube');
const { downloadTrackForGame, ytPlaylist, ytInfoPreferMusic, buildYoutubeMetadata, cleanChannelName } = youtubeModule;

const MEDIA_ROOT = process.env.MEDIA_ROOT || '/media';
const PORT       = Number.parseInt(process.env.PORT || '3000', 10);

// Délais de grâce (en minutes) affichés dans les logs et envoyés aux clients
const MASTER_GRACE_MIN = Math.round(GameManager.MASTER_RECONNECT_GRACE / 60000);
const PLAYER_GRACE_MIN = Math.round(GameManager.PLAYER_RECONNECT_GRACE / 60000);

// ─── Logger ───────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toTimeString().slice(0, 8); // HH:MM:SS
}

const log = {
  info:  (...a) => console.log( `[${ts()}] ℹ`, ...a),
  ok:    (...a) => console.log( `[${ts()}] ✔`, ...a),
  warn:  (...a) => console.warn(`[${ts()}] ⚠`, ...a),
  error: (...a) => console.error(`[${ts()}] ✖`, ...a),
  event: (...a) => console.log( `[${ts()}] ›`, ...a),
};

// ─── Express ──────────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

const gm = new GameManager();

app.use(express.json());
app.use('/api/media',   mediaRouter(MEDIA_ROOT));
app.use('/api/youtube', youtubeModule(io));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Servir le client buildé
const clientDist = path.join(__dirname, '../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

// ─── Helpers Socket.io ────────────────────────────────────────────────────────

/** Valide que le socket est bien le maître du jeu avec le bon token. */
function asMaster(socket, token) {
  const game = gm.getGameBySocket(socket.id);
  if (!game) return null;
  if (game.masterToken !== token) return null;
  if (game.masterId !== socket.id) return null;
  return game;
}

/** Émet l'état du joueur à tous les membres de la room. */
function broadcastPlayerState(game) {
  io.to(game.id).emit('state', game.getPlayerState());
}

/**
 * Émet vers le maître courant. Son socketId change à chaque reconnexion : les
 * callbacks asynchrones (métadonnées YouTube, téléchargements) doivent le relire
 * au moment d'émettre plutôt que de capturer celui du départ.
 */
function emitToMaster(game, event, payload) {
  if (!game.masterId) return;
  io.to(game.masterId).emit(event, payload);
}

/** URL de streaming d'une piste (locale ou YouTube). */
function trackAudioUrl(track) {
  if (!track) return '';
  return track.type === 'local'
    ? `/api/media/stream?path=${encodeURIComponent(track.filePath)}`
    : `/api/youtube/stream/${track.id}`;
}

/** Résumé d'un joueur pour les autres clients. */
function publicPlayer(game, player) {
  return {
    id:        player.id,
    name:      player.name,
    score:     game.getDisplayScore(player.id),
    teamId:    player.teamId || null,
    connected: player.connected,
  };
}

/**
 * Tout ce qu'il faut à un joueur qui revient en cours de partie (refresh, coupure
 * réseau, mise en veille du téléphone) pour retrouver exactement l'état courant :
 * musique en cours **et sa position**, buzzs, réponses déjà envoyées, résultats.
 */
function buildPlayerResume(game, player) {
  const track   = game.playlist[game.currentTrackIndex] || null;
  const playing = game.phase === 'playing' && track;
  return {
    audioUrl:   playing ? trackAudioUrl(track) : '',
    positionMs: playing ? game.getPlaybackPositionMs() : 0,
    paused:     game.paused,
    buzzOrder:  game.getLiveBuzzOrder(),
    answered:   Array.from(game.answers.keys()),
    myAnswer:   game.answers.get(player.id) || null,
    results:    game.phase === 'results'
      ? { metadata: track?.metadata || null, results: game.getRoundResults() }
      : null,
  };
}

/**
 * Remet un joueur reconnecté au diapason via les events habituels.
 * Nécessaire quand sa vue est déjà montée (coupure réseau sans refresh) : elle ne
 * relit pas l'état initial, elle n'écoute que les events.
 */
function sendPlayerResume(socket, game, player) {
  const resume = buildPlayerResume(game, player);
  if (resume.audioUrl) {
    socket.emit('track-playing', {
      audioUrl:   resume.audioUrl,
      index:      game.currentTrackIndex,
      positionMs: resume.positionMs,
      paused:     resume.paused,
      resumed:    true,
    });
  }
  if (resume.buzzOrder.length) socket.emit('buzz-update', { buzzOrder: resume.buzzOrder });
  if (resume.results)          socket.emit('results-revealed', resume.results);
  if (game.over)               socket.emit('game-over', { scores: game.getPlayerList() });
}

/** Idem pour le maître : lecteur, réponses reçues et points déjà attribués. */
function buildMasterResume(game) {
  const track   = game.playlist[game.currentTrackIndex] || null;
  const playing = game.phase === 'playing' && track;
  return {
    audioUrl:   playing ? trackAudioUrl(track) : '',
    positionMs: playing ? game.getPlaybackPositionMs() : 0,
    paused:     game.paused,
    metadata:   track?.metadata || null,
    results:    game.phase === 'lobby' ? [] : game.getRoundResults(),
  };
}

function sendMasterResume(socket, game) {
  const resume = buildMasterResume(game);
  if (resume.audioUrl) {
    socket.emit('track-playing', {
      audioUrl:   resume.audioUrl,
      index:      game.currentTrackIndex,
      positionMs: resume.positionMs,
      paused:     resume.paused,
      resumed:    true,
    });
  }
  if (resume.metadata) socket.emit('track-meta', resume.metadata);
  socket.emit('playlist-updated', game.playlist);
  if (resume.results.length) {
    socket.emit('answers-snapshot', {
      answers: Object.fromEntries(game.answers),
      awards:  Object.fromEntries(game.roundAwards),
      results: resume.results,
    });
  }
  socket.emit('buzz-update', { buzzOrder: game.getLiveBuzzOrder() });
  if (game.over) socket.emit('game-over', { scores: game.getPlayerList() });
}

/** Le délai de grâce d'un joueur déconnecté a expiré : il quitte réellement la partie. */
function onPlayerExpired(game, player) {
  log.info(`[${game.id}] Joueur retiré (absent depuis ${PLAYER_GRACE_MIN} min) : "${player.name}"`);
  io.to(game.id).emit('player-left', { playerId: player.id, playerName: player.name });
  broadcastPlayerState(game);
}

// ─── Socket.io ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  log.info(`Connexion  ${socket.id}  (${socket.handshake.address})`);

  // ── Créer une partie ───────────────────────────────────────────────────────
  socket.on('create-game', (cb) => {
    try {
      const game = gm.createGame(socket.id);
      socket.join(game.id);
      log.ok(`Partie créée : ${game.id}  (MJ: ${socket.id})`);
      cb?.({ ok: true, roomCode: game.id, masterToken: game.masterToken });
    } catch (err) {
      log.error('create-game :', err.message);
      cb?.({ ok: false, error: 'Erreur lors de la création' });
    }
  });

  // ── Rejoindre en tant que joueur ───────────────────────────────────────────
  socket.on('join-game', ({ roomCode, name } = {}, cb) => {
    try {
      const { game, player, reclaimed } = gm.joinGame(roomCode, socket.id, name);
      socket.join(game.id);
      log.ok(`[${game.id}] ${reclaimed ? 'Joueur repris' : 'Joueur rejoint'} : "${player.name}"  (${socket.id})  — ${game.players.size} joueur(s)`);
      io.to(game.id).emit('player-joined', publicPlayer(game, player));
      broadcastPlayerState(game);
      cb?.({
        ok:          true,
        playerId:    player.id,
        playerToken: player.token,
        state:       { ...game.getPlayerState(), resume: buildPlayerResume(game, player) },
      });
    } catch (err) {
      log.warn(`join-game échoué (code="${roomCode}", nom="${name}") :`, err.message);
      cb?.({ ok: false, error: err.message });
    }
  });

  // ── Reconnexion joueur (refresh, coupure réseau, veille du téléphone) ──────
  // Le joueur est identifié par son token et non par son socket : il retrouve
  // son score, son équipe et ses réponses exactement là où il les avait laissés.
  socket.on('rejoin-player', ({ roomCode, playerToken } = {}, cb) => {
    try {
      const { game, player } = gm.rejoinPlayer(roomCode, socket.id, playerToken);
      socket.join(game.id);
      log.ok(`[${game.id}] Joueur reconnecté : "${player.name}"  (${socket.id})`);
      socket.to(game.id).emit('player-online', { playerId: player.id, playerName: player.name });
      broadcastPlayerState(game);
      cb?.({
        ok:          true,
        playerId:    player.id,
        playerToken: player.token,
        state:       { ...game.getPlayerState(), resume: buildPlayerResume(game, player) },
      });
      sendPlayerResume(socket, game, player);
    } catch (err) {
      log.warn(`rejoin-player échoué (code="${roomCode}", socket=${socket.id}) :`, err.message);
      cb?.({ ok: false, error: err.message });
    }
  });

  // ── Quitter volontairement la partie (bouton « Quitter ») ──────────────────
  // Contrairement à une déconnexion, le joueur est retiré tout de suite.
  socket.on('leave-game', (cb) => {
    const result = gm.quitGame(socket.id);
    if (!result) return cb?.({ ok: true });

    const { game, player } = result;
    socket.leave(game.id);
    log.info(`[${game.id}] Joueur parti : "${player.name}"`);
    io.to(game.id).emit('player-left', { playerId: player.id, playerName: player.name });
    broadcastPlayerState(game);
    cb?.({ ok: true });
  });

  // ── Reconnexion maître (après refresh ou crash) ───────────────────────────
  socket.on('reconnect-master', ({ roomCode, masterToken } = {}, cb) => {
    const game = gm.getGame(roomCode);
    if (!game || game.masterToken !== masterToken) {
      log.warn(`reconnect-master échoué (code="${roomCode}", socket=${socket.id})`);
      return cb?.({ ok: false, error: 'Code ou token invalide' });
    }
    if (game.masterReconnectTimer) {
      clearTimeout(game.masterReconnectTimer);
      game.masterReconnectTimer = null;
    }
    if (game.masterId) gm.socketToRoom.delete(game.masterId);
    game.masterId     = socket.id;
    game.masterOnline = true;
    gm.socketToRoom.set(socket.id, game.id);
    socket.join(game.id);
    socket.to(game.id).emit('master-online');
    broadcastPlayerState(game);
    log.ok(`[${game.id}] MJ reconnecté (${socket.id})`);
    cb?.({ ok: true, state: { ...game.getMasterState(), resume: buildMasterResume(game) } });
    sendMasterResume(socket, game);
  });

  // ── Soumettre une réponse (joueur, mode 'text') ────────────────────────────
  socket.on('submit-answer', ({ artist, title } = {}) => {
    const game = gm.getGameBySocket(socket.id);
    if (!game || game.phase !== 'playing' || game.mode !== 'text') return;

    const player = game.getPlayerBySocket(socket.id);
    if (!player) return; // le maître (ou un socket périmé) ne répond pas

    game.submitAnswer(player.id, { artist, title });
    log.event(`[${game.id}] Réponse de "${player.name}" — artiste: "${artist || ''}" titre: "${title || ''}"`);

    if (game.masterId) {
      io.to(game.masterId).emit('player-answered', {
        playerId:   player.id,
        playerName: player.name,
        answer:     { artist: (artist || '').trim(), title: (title || '').trim() },
      });
    }
    socket.to(game.id).except(game.masterId || []).emit('someone-answered', { playerId: player.id });
  });

  // ── Buzzer (joueur, mode 'buzzer') ─────────────────────────────────────────
  socket.on('buzz', () => {
    const game = gm.getGameBySocket(socket.id);
    if (!game || game.phase !== 'playing' || game.mode !== 'buzzer') return;

    const player = game.getPlayerBySocket(socket.id);
    if (!player) return;

    const entry = game.registerBuzz(player.id);
    if (!entry) return; // déjà buzzé, ou équipe déjà verrouillée

    const buzzOrder = game.getLiveBuzzOrder();
    log.event(`[${game.id}] Buzz #${entry.order} : "${player.name}" (${entry.reactionMs ?? '?'}ms)`);

    io.to(game.id).emit('buzz-update', { buzzOrder });

    // Couper la musique pour tout le monde le temps que le maître juge la réponse
    if (game.pausePlayback()) {
      log.info(`[${game.id}] ⏸ Pause automatique (buzz de "${player.name}")`);
      io.to(game.id).emit('track-paused');
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // COMMANDES MAÎTRE
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Ajouter une piste locale ───────────────────────────────────────────────
  socket.on('master:add-local', ({ token, filePath } = {}, cb) => {
    const game = asMaster(socket, token);
    if (!game) return cb?.({ ok: false, error: 'Non autorisé' });

    try {
      const { parseFromPath } = require('./utils/parseMedia');
      const metadata = parseFromPath(filePath, MEDIA_ROOT);
      const track = {
        id:        uuidv4(),
        type:      'local',
        filePath,
        metadata,
        status:    'ready',
        localPath: null,
      };
      game.playlist.push(track);
      log.ok(`[${game.id}] Piste locale ajoutée : "${metadata.artist} — ${metadata.title}"  (${path.basename(filePath)})`);
      io.to(socket.id).emit('playlist-updated', game.playlist);
      cb?.({ ok: true, track });
    } catch (err) {
      log.error(`[${game.id}] master:add-local :`, err.message);
      cb?.({ ok: false, error: err.message });
    }
  });

  // ── Ajouter une URL YouTube ────────────────────────────────────────────────
  socket.on('master:add-youtube', async ({ token, url } = {}, cb) => {
    const game = asMaster(socket, token);
    if (!game) return cb?.({ ok: false, error: 'Non autorisé' });

    const track = {
      id:         uuidv4(),
      type:       'youtube',
      youtubeUrl: url,
      metadata:   { artist: '', title: url, channel: '', album: '', year: '' },
      status:     'pending',
      localPath:  null,
    };
    game.playlist.push(track);
    log.info(`[${game.id}] YouTube ajouté (en attente) : ${url}`);
    io.to(socket.id).emit('playlist-updated', game.playlist);
    cb?.({ ok: true, track });

    // Récupérer les métadonnées en arrière-plan : YouTube Music d'abord (artiste/album
    // mieux renseignés), repli sur YouTube classique si indisponible (voir ytInfoPreferMusic).
    ytInfoPreferMusic(url)
      .then(data => {
        track.metadata = buildYoutubeMetadata(data);
        log.info(`[${game.id}] Métadonnées YouTube : "${track.metadata.title}" (chaîne : ${track.metadata.channel || '?'})`);
        emitToMaster(game, 'playlist-updated', game.playlist);
      })
      .catch(err => log.warn(`[${game.id}] ytInfo échoué pour ${url} :`, err.message));

    // Téléchargement audio en arrière-plan
    downloadTrackForGame({ game, track, io, masterSocketId: socket.id })
      .catch(err => log.error(`[${game.id}] Téléchargement YouTube échoué :`, err.message));
  });

  // ── Importer une playlist YouTube ─────────────────────────────────────────
  socket.on('master:import-playlist', async ({ token, playlistUrl } = {}, cb) => {
    const game = asMaster(socket, token);
    if (!game) return cb?.({ ok: false, error: 'Non autorisé' });

    try {
      log.info(`[${game.id}] Import playlist YouTube : ${playlistUrl}`);
      const entries = await ytPlaylist(playlistUrl);
      const newTracks = entries.map(e => ({
        id:         uuidv4(),
        type:       'youtube',
        youtubeUrl: e.url || `https://www.youtube.com/watch?v=${e.id}`,
        // Le format --flat-playlist ne fournit pas artist/track (extraction complète requise) ;
        // on affiche déjà la chaîne, affinée en arrière-plan via ytInfo ci-dessous.
        metadata:   { artist: '', title: e.title || '', channel: cleanChannelName(e.channel || e.uploader || ''), album: '', year: '' },
        status:     'pending',
        localPath:  null,
      }));
      game.playlist.push(...newTracks);
      log.ok(`[${game.id}] Playlist importée : ${newTracks.length} piste(s)`);
      io.to(socket.id).emit('playlist-updated', game.playlist);
      cb?.({ ok: true, count: newTracks.length });

      for (const track of newTracks) {
        ytInfoPreferMusic(track.youtubeUrl)
          .then(data => {
            track.metadata = buildYoutubeMetadata(data);
            emitToMaster(game, 'playlist-updated', game.playlist);
          })
          .catch(err => log.warn(`[${game.id}] ytInfo échoué pour ${track.youtubeUrl} :`, err.message));

        downloadTrackForGame({ game, track, io, masterSocketId: socket.id })
          .catch(err => log.error(`[${game.id}] Téléchargement échoué "${track.metadata.title}" :`, err.message));
      }
    } catch (err) {
      log.error(`[${game.id}] master:import-playlist :`, err.message);
      cb?.({ ok: false, error: err.message });
    }
  });

  // ── Relancer le téléchargement d'une piste YouTube en erreur ───────────────
  socket.on('master:retry-track', ({ token, index } = {}, cb) => {
    const game = asMaster(socket, token);
    if (!game) return cb?.({ ok: false });

    const track = game.playlist[index];
    if (!track) return cb?.({ ok: false, error: 'Piste introuvable' });
    if (track.type !== 'youtube') return cb?.({ ok: false, error: 'Seules les pistes YouTube peuvent être retéléchargées' });

    track.status = 'pending';
    track.error  = null;
    log.info(`[${game.id}] Nouvelle tentative de téléchargement [${index}] : ${track.youtubeUrl}`);
    io.to(socket.id).emit('playlist-updated', game.playlist);
    cb?.({ ok: true });

    downloadTrackForGame({ game, track, io, masterSocketId: socket.id })
      .catch(err => log.error(`[${game.id}] Nouvelle tentative de téléchargement échouée :`, err.message));
  });

  // ── Supprimer une piste ────────────────────────────────────────────────────
  socket.on('master:remove-track', ({ token, index } = {}, cb) => {
    const game = asMaster(socket, token);
    if (!game) return cb?.({ ok: false });
    const removed = game.playlist[index];
    game.playlist.splice(index, 1);
    if (game.currentTrackIndex >= game.playlist.length) {
      game.currentTrackIndex = game.playlist.length - 1;
    }
    log.info(`[${game.id}] Piste supprimée [${index}] : "${removed?.metadata?.title || '?'}"`);
    io.to(socket.id).emit('playlist-updated', game.playlist);
    cb?.({ ok: true });
  });

  // ── Réordonner la playlist ─────────────────────────────────────────────────
  socket.on('master:reorder', ({ token, from, to } = {}, cb) => {
    const game = asMaster(socket, token);
    if (!game) return cb?.({ ok: false });
    const [item] = game.playlist.splice(from, 1);
    game.playlist.splice(to, 0, item);
    io.to(socket.id).emit('playlist-updated', game.playlist);
    cb?.({ ok: true });
  });

  // ── Mélanger l'ordre de la playlist ─────────────────────────────────────────
  socket.on('master:shuffle', ({ token } = {}, cb) => {
    const game = asMaster(socket, token);
    if (!game) return cb?.({ ok: false });

    const currentTrack = game.playlist[game.currentTrackIndex] || null;

    // Fisher-Yates
    for (let i = game.playlist.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [game.playlist[i], game.playlist[j]] = [game.playlist[j], game.playlist[i]];
    }

    // Garder l'index à jour si une piste est en cours de lecture
    if (currentTrack) game.currentTrackIndex = game.playlist.indexOf(currentTrack);

    log.info(`[${game.id}] Playlist mélangée (${game.playlist.length} piste(s))`);
    io.to(socket.id).emit('playlist-updated', game.playlist);
    cb?.({ ok: true });
  });

  // ── Lancer une piste ───────────────────────────────────────────────────────
  socket.on('master:play', ({ token, index } = {}, cb) => {
    const game = asMaster(socket, token);
    if (!game) return cb?.({ ok: false });

    const idx   = (index !== undefined && index !== null) ? index : Math.max(0, game.currentTrackIndex);
    const track = game.playlist[idx];
    if (!track) return cb?.({ ok: false, error: 'Piste introuvable' });
    if (track.status !== 'ready') return cb?.({ ok: false, error: 'Piste pas encore prête (téléchargement en cours)' });

    game.currentTrackIndex = idx;
    game.phase = 'playing';
    game.over  = false;
    game.resetRound();
    game.startPlayback();

    const audioUrl = trackAudioUrl(track);

    log.ok(`[${game.id}] ▶ Lecture [${idx}] : "${track.metadata.artist} — ${track.metadata.title}"  (${track.type})`);

    io.to(game.id).emit('track-playing', { audioUrl, index: idx, positionMs: 0 });
    io.to(socket.id).emit('track-meta', track.metadata);
    broadcastPlayerState(game);
    cb?.({ ok: true });
  });

  // ── Reprendre la musique après une pause déclenchée par un buzz ────────────
  socket.on('master:resume', ({ token } = {}, cb) => {
    const game = asMaster(socket, token);
    if (!game) return cb?.({ ok: false });
    if (!game.resumePlayback()) return cb?.({ ok: true });

    log.info(`[${game.id}] ▶ Reprise de la musique après buzz`);
    io.to(game.id).emit('track-resumed');
    cb?.({ ok: true });
  });

  // ── Stopper la musique ────────────────────────────────────────────────────
  socket.on('master:stop', ({ token } = {}, cb) => {
    const game = asMaster(socket, token);
    if (!game) return cb?.({ ok: false });

    game.phase = 'stopped';
    game.stopPlayback();
    const answersCount = game.answers.size;
    log.info(`[${game.id}] ⏹ Stop — ${answersCount}/${game.players.size} réponse(s)`);

    io.to(game.id).emit('track-stopped');
    io.to(socket.id).emit('answers-snapshot', {
      answers: Object.fromEntries(game.answers),
      awards:  Object.fromEntries(game.roundAwards),
      results: game.getRoundResults(),
    });
    broadcastPlayerState(game);
    cb?.({ ok: true });
  });

  // ── Ajuster manuellement le score total d'un joueur ────────────────────────
  socket.on('master:adjust-score', ({ token, playerId, delta } = {}, cb) => {
    const game = asMaster(socket, token);
    if (!game) return cb?.({ ok: false });

    try {
      game.adjustScore(playerId, delta);
      const playerName = game.players.get(playerId)?.name || playerId;
      log.event(`[${game.id}] Score ajusté (${delta > 0 ? '+' : ''}${delta}) : "${playerName}"`);

      broadcastPlayerState(game);
      io.to(socket.id).emit('results-update', game.getRoundResults());
      cb?.({ ok: true });
    } catch (err) {
      cb?.({ ok: false, error: err.message });
    }
  });

  // ── Attribuer / retirer un point (maître, mode 'text') ────────────────────
  socket.on('master:award', ({ token, playerId, field, value } = {}, cb) => {
    const game = asMaster(socket, token);
    if (!game) return cb?.({ ok: false });

    game.setAward(playerId, field, value);
    const playerName = game.players.get(playerId)?.name || playerId;
    log.event(`[${game.id}] Point ${value ? 'attribué' : 'retiré'} : "${playerName}" → ${field}`);

    broadcastPlayerState(game);
    io.to(socket.id).emit('results-update', game.getRoundResults());
    cb?.({ ok: true });
  });

  // ── Attribuer des points (maître, mode 'buzzer') ───────────────────────────
  socket.on('master:buzzer-award', ({ token, playerId, teamId, points } = {}, cb) => {
    const game = asMaster(socket, token);
    if (!game) return cb?.({ ok: false });

    try {
      if (teamId) {
        game.setBuzzerPointsForTeam(teamId, points);
        log.event(`[${game.id}] ${points} pt(s) attribué(s) à l'équipe "${game.teams.get(teamId)?.name}"`);
      } else {
        game.setBuzzerPoints(playerId, points);
        const playerName = game.players.get(playerId)?.name || playerId;
        log.event(`[${game.id}] ${points} pt(s) attribué(s) : "${playerName}"`);
      }
      broadcastPlayerState(game);
      io.to(socket.id).emit('results-update', game.getRoundResults());
      cb?.({ ok: true });
    } catch (err) {
      cb?.({ ok: false, error: err.message });
    }
  });

  // ── Changer le mode de jeu ('text' | 'buzzer') ─────────────────────────────
  socket.on('master:set-mode', ({ token, mode } = {}, cb) => {
    const game = asMaster(socket, token);
    if (!game) return cb?.({ ok: false });
    if (game.phase === 'playing') return cb?.({ ok: false, error: 'Impossible pendant la lecture' });

    try {
      game.setMode(mode);
      log.info(`[${game.id}] Mode de jeu → ${mode}`);
      broadcastPlayerState(game);
      cb?.({ ok: true });
    } catch (err) {
      cb?.({ ok: false, error: err.message });
    }
  });

  // ── Créer une équipe ────────────────────────────────────────────────────────
  socket.on('master:create-team', ({ token, name } = {}, cb) => {
    const game = asMaster(socket, token);
    if (!game) return cb?.({ ok: false });

    const team = game.createTeam(name);
    log.info(`[${game.id}] Équipe créée : "${team.name}"`);
    broadcastPlayerState(game);
    cb?.({ ok: true, team });
  });

  // ── Supprimer une équipe ────────────────────────────────────────────────────
  socket.on('master:delete-team', ({ token, teamId } = {}, cb) => {
    const game = asMaster(socket, token);
    if (!game) return cb?.({ ok: false });

    game.deleteTeam(teamId);
    log.info(`[${game.id}] Équipe supprimée : ${teamId}`);
    broadcastPlayerState(game);
    cb?.({ ok: true });
  });

  // ── Assigner un joueur à une équipe (teamId=null pour retirer) ─────────────
  socket.on('master:assign-team', ({ token, playerId, teamId } = {}, cb) => {
    const game = asMaster(socket, token);
    if (!game) return cb?.({ ok: false });

    try {
      game.assignPlayerTeam(playerId, teamId || null);
      const playerName = game.players.get(playerId)?.name || playerId;
      log.info(`[${game.id}] "${playerName}" → équipe ${teamId || '(aucune)'}`);
      broadcastPlayerState(game);
      cb?.({ ok: true });
    } catch (err) {
      cb?.({ ok: false, error: err.message });
    }
  });

  // ── Révéler les résultats ─────────────────────────────────────────────────
  socket.on('master:reveal', ({ token } = {}, cb) => {
    const game = asMaster(socket, token);
    if (!game) return cb?.({ ok: false });

    game.phase = 'results';
    const track   = game.playlist[game.currentTrackIndex];
    const results = game.getRoundResults();

    const summary = results.map(r => `${r.playerName}:${r.roundPoints}pt`).join(', ');
    log.ok(`[${game.id}] Résultats révélés — ${summary}`);

    io.to(game.id).emit('results-revealed', { metadata: track?.metadata || null, results });
    broadcastPlayerState(game);
    cb?.({ ok: true });
  });

  // ── Piste suivante ────────────────────────────────────────────────────────
  socket.on('master:next', ({ token } = {}, cb) => {
    const game = asMaster(socket, token);
    if (!game) return cb?.({ ok: false });

    game.commitRound();

    const nextIndex = game.currentTrackIndex + 1;
    if (nextIndex >= game.playlist.length) {
      game.phase = 'results';
      game.over  = true;
      const scores = game.getPlayerList().map(p => `${p.name}:${p.score}pt`).join(', ');
      log.ok(`[${game.id}] Fin de partie — ${scores}`);
      io.to(game.id).emit('game-over', { scores: game.getPlayerList() });
      return cb?.({ ok: true, gameOver: true });
    }

    game.currentTrackIndex = nextIndex;
    game.resetRound();
    game.phase = 'lobby';
    log.info(`[${game.id}] Piste suivante → [${nextIndex}] "${game.playlist[nextIndex]?.metadata?.title || '?'}"`);
    io.to(game.id).emit('round-reset', { nextTrackIndex: nextIndex });
    broadcastPlayerState(game);
    cb?.({ ok: true, gameOver: false, nextIndex });
  });

  // ── Rejouer la piste courante ──────────────────────────────────────────────
  socket.on('master:replay', ({ token } = {}, cb) => {
    const game = asMaster(socket, token);
    if (!game) return cb?.({ ok: false });

    const track = game.playlist[game.currentTrackIndex];
    if (!track || track.status !== 'ready') return cb?.({ ok: false, error: 'Piste non prête' });

    const audioUrl = trackAudioUrl(track);

    game.phase = 'playing';
    game.over  = false;
    // La piste repart du début : le chrono des temps de réaction aussi.
    game.startPlayback();
    log.info(`[${game.id}] ↺ Replay : "${track.metadata.artist} — ${track.metadata.title}"`);
    io.to(game.id).emit('track-playing', { audioUrl, index: game.currentTrackIndex, positionMs: 0 });
    io.to(socket.id).emit('track-meta', track.metadata);
    broadcastPlayerState(game);
    cb?.({ ok: true });
  });

  // ── Terminer la partie (le MJ y met fin pour tout le monde) ────────────────
  socket.on('master:end-game', ({ token } = {}, cb) => {
    const game = asMaster(socket, token);
    if (!game) return cb?.({ ok: false, error: 'Non autorisé' });

    const roomCode    = game.id;
    const playerCount = game.players.size;
    log.warn(`[${roomCode}] Partie terminée par le MJ — ${playerCount} joueur(s)`);

    // Le MJ gère son propre retour à l'accueil via la réponse ok (il vient de confirmer
    // l'action, inutile de lui afficher la même alerte qu'aux joueurs).
    socket.to(roomCode).emit('game-ended', { reason: 'Le maître du jeu a terminé la partie.' });
    gm.deleteGame(roomCode);
    io.in(roomCode).socketsLeave(roomCode);
    cb?.({ ok: true });
  });

  // ── Déconnexion ────────────────────────────────────────────────────────────
  socket.on('disconnect', (reason) => {
    const game = gm.getGameBySocket(socket.id);
    const context = game ? `[${game.id}] ` : '';
    log.info(`${context}Déconnexion ${socket.id}  (${reason})`);

    const result = gm.leaveGame(socket.id, onPlayerExpired);
    if (!result) return;

    const { game: g, masterLeft, player } = result;
    if (masterLeft) {
      log.warn(`[${g.id}] MJ déconnecté — délai de grâce ${MASTER_GRACE_MIN} min`);
      io.to(g.id).emit('master-offline', { gracePeriodMs: GameManager.MASTER_RECONNECT_GRACE });
      broadcastPlayerState(g);
    } else if (player) {
      // Le joueur n'est pas éliminé : il reste au classement avec ses points, en
      // attendant de revenir (refresh, réseau, veille…).
      log.info(`[${g.id}] Joueur hors ligne : "${player.name}" — points conservés ${PLAYER_GRACE_MIN} min`);
      io.to(g.id).emit('player-offline', { playerId: player.id, playerName: player.name });
      broadcastPlayerState(g);
    }
  });
});

// ─── Gestion des erreurs non catchées ─────────────────────────────────────────

process.on('uncaughtException',  err => log.error('Exception non catchée :', err));
process.on('unhandledRejection', err => log.error('Promise rejetée :', err));

// ─── Démarrage ────────────────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', () => {
  log.ok(`BlindTest server démarré — port ${PORT}`);
  log.info(`Répertoire média : ${MEDIA_ROOT}`);
  log.info(`Client buildé    : ${fs.existsSync(clientDist) ? clientDist : 'non trouvé (mode dev)'}`);
});
