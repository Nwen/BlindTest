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
const { downloadTrackForGame, ytPlaylist, ytInfo } = youtubeModule;

const MEDIA_ROOT = process.env.MEDIA_ROOT || '/media';
const PORT       = Number.parseInt(process.env.PORT || '3000', 10);

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
      const game = gm.joinGame(roomCode, socket.id, name);
      socket.join(game.id);
      log.ok(`[${game.id}] Joueur rejoint : "${name}"  (${socket.id})  — ${game.players.size} joueur(s)`);
      io.to(game.id).emit('player-joined', { id: socket.id, name: name.trim(), score: 0 });
      cb?.({ ok: true, state: game.getPlayerState() });
    } catch (err) {
      log.warn(`join-game échoué (code="${roomCode}", nom="${name}") :`, err.message);
      cb?.({ ok: false, error: err.message });
    }
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
    cb?.({ ok: true, state: game.getMasterState() });
  });

  // ── Soumettre une réponse (joueur, mode 'text') ────────────────────────────
  socket.on('submit-answer', ({ artist, title } = {}) => {
    const game = gm.getGameBySocket(socket.id);
    if (!game || game.phase !== 'playing' || game.mode !== 'text') return;
    if (game.masterId === socket.id) return;

    game.submitAnswer(socket.id, { artist, title });
    const player = game.players.get(socket.id);
    log.event(`[${game.id}] Réponse de "${player?.name}" — artiste: "${artist || ''}" titre: "${title || ''}"`);

    io.to(game.masterId).emit('player-answered', {
      playerId:   socket.id,
      playerName: player?.name || '?',
      answer:     { artist: (artist || '').trim(), title: (title || '').trim() },
    });
    socket.to(game.id).except(game.masterId).emit('someone-answered', { playerId: socket.id });
  });

  // ── Buzzer (joueur, mode 'buzzer') ─────────────────────────────────────────
  socket.on('buzz', () => {
    const game = gm.getGameBySocket(socket.id);
    if (!game || game.phase !== 'playing' || game.mode !== 'buzzer') return;
    if (game.masterId === socket.id) return;

    const entry = game.registerBuzz(socket.id);
    if (!entry) return; // déjà buzzé, ou équipe déjà verrouillée

    const player    = game.players.get(socket.id);
    const buzzOrder = game.getLiveBuzzOrder();
    log.event(`[${game.id}] Buzz #${entry.order} : "${player?.name}" (${entry.reactionMs ?? '?'}ms)`);

    io.to(game.id).emit('buzz-update', { buzzOrder });
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
      metadata:   { artist: '', title: url, album: '', year: '' },
      status:     'pending',
      localPath:  null,
    };
    game.playlist.push(track);
    log.info(`[${game.id}] YouTube ajouté (en attente) : ${url}`);
    io.to(socket.id).emit('playlist-updated', game.playlist);
    cb?.({ ok: true, track });

    // Récupérer les métadonnées en arrière-plan
    // Pas d'extraction artiste/titre pour YouTube : le titre brut de la vidéo est affiché tel quel.
    ytInfo(url)
      .then(data => {
        const title = data.title || url;
        track.metadata = {
          artist: '', title, album: '',
          year: String(data.release_year || data.upload_date?.slice(0, 4) || ''),
        };
        log.info(`[${game.id}] Métadonnées YouTube : "${title}"`);
        io.to(socket.id).emit('playlist-updated', game.playlist);
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
        metadata:   { artist: '', title: e.title || '', album: '', year: '' },
        status:     'pending',
        localPath:  null,
      }));
      game.playlist.push(...newTracks);
      log.ok(`[${game.id}] Playlist importée : ${newTracks.length} piste(s)`);
      io.to(socket.id).emit('playlist-updated', game.playlist);
      cb?.({ ok: true, count: newTracks.length });

      for (const track of newTracks) {
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
    game.resetRound();
    game.trackStartedAt = Date.now();

    const audioUrl = track.type === 'local'
      ? `/api/media/stream?path=${encodeURIComponent(track.filePath)}`
      : `/api/youtube/stream/${track.id}`;

    log.ok(`[${game.id}] ▶ Lecture [${idx}] : "${track.metadata.artist} — ${track.metadata.title}"  (${track.type})`);

    io.to(game.id).emit('track-playing', { audioUrl, index: idx });
    io.to(socket.id).emit('track-meta', track.metadata);
    broadcastPlayerState(game);
    cb?.({ ok: true });
  });

  // ── Stopper la musique ────────────────────────────────────────────────────
  socket.on('master:stop', ({ token } = {}, cb) => {
    const game = asMaster(socket, token);
    if (!game) return cb?.({ ok: false });

    game.phase = 'stopped';
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

    const audioUrl = track.type === 'local'
      ? `/api/media/stream?path=${encodeURIComponent(track.filePath)}`
      : `/api/youtube/stream/${track.id}`;

    game.phase = 'playing';
    log.info(`[${game.id}] ↺ Replay : "${track.metadata.artist} — ${track.metadata.title}"`);
    io.to(game.id).emit('track-playing', { audioUrl, index: game.currentTrackIndex });
    io.to(socket.id).emit('track-meta', track.metadata);
    broadcastPlayerState(game);
    cb?.({ ok: true });
  });

  // ── Déconnexion ────────────────────────────────────────────────────────────
  socket.on('disconnect', (reason) => {
    const game = gm.getGameBySocket(socket.id);
    const context = game ? `[${game.id}] ` : '';
    log.info(`${context}Déconnexion ${socket.id}  (${reason})`);

    const result = gm.leaveGame(socket.id);
    if (!result) return;

    const { game: g, masterLeft } = result;
    if (masterLeft) {
      log.warn(`[${g.id}] MJ déconnecté — délai de grâce 5 min`);
      io.to(g.id).emit('master-offline', { gracePeriodMs: 5 * 60 * 1000 });
      broadcastPlayerState(g);
    } else {
      const name = game?.players?.get(socket.id)?.name;
      if (name) log.info(`[${g.id}] Joueur parti : "${name}"`);
      io.to(g.id).emit('player-left', { playerId: socket.id });
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
