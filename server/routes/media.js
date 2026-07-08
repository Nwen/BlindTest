'use strict';

const express = require('express');
const path    = require('path');
const fs      = require('fs');

const AUDIO_EXTS = new Set(['.mp3', '.flac', '.opus', '.ogg', '.wav', '.m4a', '.aac', '.webm', '.wv', '.ape']);

const MIME = {
  '.mp3':  'audio/mpeg',
  '.flac': 'audio/flac',
  '.opus': 'audio/ogg; codecs=opus',
  '.ogg':  'audio/ogg',
  '.wav':  'audio/wav',
  '.m4a':  'audio/mp4',
  '.aac':  'audio/aac',
  '.webm': 'audio/webm',
  '.wv':   'audio/x-wavpack',
  '.ape':  'audio/x-ape',
};

/**
 * @param {string} mediaRoot  Chemin absolu racine de la bibliothèque (ex : /media)
 */
module.exports = function mediaRouter(mediaRoot) {
  const router = express.Router();

  /** Vérifie que le chemin résolu est bien sous mediaRoot (anti path-traversal). */
  function safeResolve(inputPath) {
    const resolved = path.resolve(inputPath);
    if (!resolved.startsWith(path.resolve(mediaRoot))) return null;
    return resolved;
  }

  // ── GET /api/media/browse?dir=<chemin> ────────────────────────────────────
  router.get('/browse', (req, res) => {
    const dir = req.query.dir || mediaRoot;
    const safe = safeResolve(dir);
    if (!safe) return res.status(403).json({ error: 'Accès refusé' });

    let entries;
    try {
      entries = fs.readdirSync(safe, { withFileTypes: true });
    } catch {
      return res.status(404).json({ error: 'Dossier introuvable' });
    }

    const items = entries
      .map(e => {
        const ext = path.extname(e.name).toLowerCase();
        return {
          name:    e.name,
          path:    path.join(safe, e.name),
          isDir:   e.isDirectory(),
          isAudio: !e.isDirectory() && AUDIO_EXTS.has(ext),
        };
      })
      .filter(e => e.isDir || e.isAudio)
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { numeric: true });
      });

    res.json({
      dir:    safe,
      root:   path.resolve(mediaRoot),
      parent: path.dirname(safe),
      items,
    });
  });

  // ── GET /api/media/stream?path=<chemin> ───────────────────────────────────
  router.get('/stream', (req, res) => {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'Paramètre path manquant' });

    const safe = safeResolve(filePath);
    if (!safe) return res.status(403).json({ error: 'Accès refusé' });

    if (!fs.existsSync(safe)) return res.status(404).json({ error: 'Fichier introuvable' });

    const stat        = fs.statSync(safe);
    const fileSize    = stat.size;
    const ext         = path.extname(safe).toLowerCase();
    const contentType = MIME[ext] || 'audio/mpeg';
    const range       = req.headers.range;

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');

    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end   = endStr ? parseInt(endStr, 10) : fileSize - 1;
      const chunk = end - start + 1;

      res.writeHead(206, {
        'Content-Range':  `bytes ${start}-${end}/${fileSize}`,
        'Content-Length': chunk,
      });
      fs.createReadStream(safe, { start, end }).pipe(res);
    } else {
      res.setHeader('Content-Length', fileSize);
      res.status(200);
      fs.createReadStream(safe).pipe(res);
    }
  });

  return router;
};
