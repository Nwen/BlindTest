'use strict';

const express = require('express');
const { spawn } = require('node:child_process');
const path      = require('node:path');
const fs        = require('node:fs');
const os        = require('node:os');

// Sur Windows, les fichiers téléchargés vont dans %TEMP%\blindtest
const CACHE_DIR = process.env.YT_CACHE
  || (process.platform === 'win32'
      ? path.join(os.tmpdir(), 'blindtest')
      : '/tmp/blindtest');

// ─── Résolution du chemin yt-dlp ─────────────────────────────────────────────

/**
 * Retourne la commande yt-dlp à utiliser.
 * Sur Windows, cherche dans le dossier WinGet si la commande n'est pas dans le PATH.
 */
function resolveYtDlp() {
  if (process.platform !== 'win32') return { cmd: 'yt-dlp', opts: {} };

  // Chercher dans le dossier WinGet (installation par défaut de winget install yt-dlp.yt-dlp)
  const localAppData = process.env.LOCALAPPDATA || '';
  const wingetPath = path.join(
    localAppData,
    'Microsoft', 'WinGet', 'Packages',
    'yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe',
    'yt-dlp.exe'
  );
  if (fs.existsSync(wingetPath)) {
    return { cmd: wingetPath, opts: {} };
  }

  // Fallback : laisser le shell le trouver dans le PATH
  return { cmd: 'yt-dlp', opts: { shell: true } };
}

const { cmd: YT_DLP, opts: SPAWN_OPTS } = resolveYtDlp();

// ─── Helpers yt-dlp ──────────────────────────────────────────────────────────

/** Récupère les métadonnées d'une vidéo YouTube (JSON). */
function ytInfo(url) {
  return new Promise((resolve, reject) => {
    const args = ['--dump-json', '--no-playlist', '--no-warnings', url];
    const proc = spawn('yt-dlp', args, SPAWN_OPTS);
    let out = '', err = '';
    proc.stdout.on('data', d => (out += d));
    proc.stderr.on('data', d => (err += d));
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(err.trim() || `yt-dlp a retourné le code ${code}`));
      try { resolve(JSON.parse(out)); }
      catch { reject(new Error('Impossible de parser la réponse yt-dlp')); }
    });
    proc.on('error', (e) => reject(new Error(
      e.code === 'ENOENT'
        ? 'yt-dlp introuvable. Installe-le : https://github.com/yt-dlp/yt-dlp/releases'
        : e.message
    )));
  });
}

/** Récupère les entrées d'une playlist YouTube (format flat). */
function ytPlaylist(url) {
  return new Promise((resolve, reject) => {
    const args = ['--flat-playlist', '--dump-json', '--no-warnings', url];
    const proc = spawn('yt-dlp', args, SPAWN_OPTS);
    let out = '', err = '';
    proc.stdout.on('data', d => (out += d));
    proc.stderr.on('data', d => (err += d));
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(err.trim() || `yt-dlp a retourné le code ${code}`));
      const lines = out.trim().split('\n').filter(Boolean);
      try {
        resolve(lines.map(l => JSON.parse(l)));
      } catch {
        reject(new Error('Impossible de parser la playlist'));
      }
    });
    proc.on('error', (e) => reject(new Error(
      e.code === 'ENOENT'
        ? 'yt-dlp introuvable. Installe-le : https://github.com/yt-dlp/yt-dlp/releases'
        : e.message
    )));
  });
}

/** Télécharge l'audio d'une vidéo YouTube dans CACHE_DIR/<trackId>.%(ext)s */
function ytDownload(url, trackId) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const template = path.join(CACHE_DIR, `${trackId}.%(ext)s`);
    const args = [
      '-f', 'bestaudio',
      '--no-playlist',
      '--no-warnings',
      '-o', template,
      url,
    ];
    const proc = spawn('yt-dlp', args, SPAWN_OPTS);
    let err = '';
    proc.stderr.on('data', d => (err += d));
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(err.trim() || `yt-dlp a retourné le code ${code}`));
      // Trouver le fichier créé (l'extension varie selon le format)
      const files = fs.readdirSync(CACHE_DIR).filter(f => f.startsWith(trackId + '.'));
      if (!files.length) return reject(new Error('Fichier introuvable après téléchargement'));
      resolve(path.join(CACHE_DIR, files[0]));
    });
    proc.on('error', (e) => reject(new Error(
      e.code === 'ENOENT'
        ? 'yt-dlp introuvable. Installe-le : https://github.com/yt-dlp/yt-dlp/releases'
        : e.message
    )));
  });
}

// ─── Téléchargement en arrière-plan ──────────────────────────────────────────

/**
 * Lance le téléchargement d'une piste YouTube et met à jour la playlist
 * du jeu + émet les events Socket.io appropriés.
 *
 * @param {{ game: object, track: object, io: object, masterSocketId: string }} opts
 */
async function downloadTrackForGame({ game, track, io, masterSocketId }) {
  const label = `[${game.id}] YT "${track.metadata?.title || track.youtubeUrl}"`;
  console.log(`[${ts()}] ℹ ${label} — téléchargement démarré`);

  track.status = 'downloading';
  io.to(masterSocketId).emit('playlist-updated', game.playlist);

  try {
    const localPath = await ytDownload(track.youtubeUrl, track.id);
    track.status    = 'ready';
    track.localPath = localPath;
    track.error     = null;
    console.log(`[${ts()}] ✔ ${label} — prêt (${path.basename(localPath)})`);
    io.to(masterSocketId).emit('playlist-updated', game.playlist);
    io.to(masterSocketId).emit('track-ready', { trackId: track.id });
  } catch (err) {
    track.status = 'error';
    track.error  = err.message;
    console.error(`[${ts()}] ✖ ${label} — échec :`, err.message);
    io.to(masterSocketId).emit('playlist-updated', game.playlist);
  }
}

function ts() {
  return new Date().toTimeString().slice(0, 8);
}

// ─── Router Express ───────────────────────────────────────────────────────────

/**
 * @param {import('socket.io').Server} io
 */
module.exports = function youtubeRouter(io) {
  const router = express.Router();

  // POST /api/youtube/info  { url }
  router.post('/info', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL manquante' });
    try {
      const info = await ytInfo(url);
      res.json({
        id:       info.id,
        title:    info.title,
        duration: info.duration,
        thumbnail: info.thumbnail,
        // Pas d'extraction artiste/titre : le titre YouTube brut est souvent mal formaté.
        parsed:   { artist: '', title: info.title || '', album: '', year: String(info.release_year || info.upload_date?.slice(0, 4) || '') },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/youtube/playlist  { url }
  router.post('/playlist', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL manquante' });
    try {
      const entries = await ytPlaylist(url);
      res.json({ entries: entries.map(e => ({ id: e.id, title: e.title, url: e.url || `https://www.youtube.com/watch?v=${e.id}` })) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/youtube/stream/:trackId
  router.get('/stream/:trackId', (req, res) => {
    const { trackId } = req.params;

    // Sanitize : alphanumérique + tirets uniquement
    if (!/^[\w-]+$/.test(trackId)) return res.status(400).json({ error: 'ID invalide' });

    const files = fs.existsSync(CACHE_DIR)
      ? fs.readdirSync(CACHE_DIR).filter(f => f.startsWith(trackId + '.'))
      : [];
    if (!files.length) return res.status(404).json({ error: 'Piste non téléchargée' });

    const filePath = path.join(CACHE_DIR, files[0]);
    const stat     = fs.statSync(filePath);
    const fileSize = stat.size;
    const ext      = path.extname(filePath).toLowerCase();
    const mimeMap  = { '.webm': 'audio/webm', '.opus': 'audio/ogg; codecs=opus', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg' };
    const contentType = mimeMap[ext] || 'audio/webm';
    const range    = req.headers.range;

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');

    if (range) {
      const [s, e] = range.replace('bytes=', '').split('-');
      const start = Number.parseInt(s, 10);
      const end   = e ? Number.parseInt(e, 10) : fileSize - 1;
      res.writeHead(206, {
        'Content-Range':  `bytes ${start}-${end}/${fileSize}`,
        'Content-Length': end - start + 1,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.setHeader('Content-Length', fileSize);
      res.status(200);
      fs.createReadStream(filePath).pipe(res);
    }
  });

  return router;
};

module.exports.downloadTrackForGame = downloadTrackForGame;
module.exports.ytPlaylist          = ytPlaylist;
module.exports.ytInfo              = ytInfo;
