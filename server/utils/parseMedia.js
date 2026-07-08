'use strict';

const path = require('path');

/**
 * Extrait artiste / titre / album / année depuis le chemin d'un fichier.
 *
 * Structure attendue (relative à MEDIA_ROOT) :
 *   <Artiste>/<Année> - <Album>/<num> - <Artiste> - <Album> - <Titre>.<ext>
 *
 * Exemple :
 *   aespa/2024 - Whiplash - The 5th Mini Album/
 *     01 - aespa - Whiplash - The 5th Mini Album - Whiplash.opus
 */
function parseFromPath(filePath, mediaRoot) {
  const rel = path.relative(mediaRoot, filePath);
  const parts = rel.split(path.sep);

  const artistDir = parts[0] || '';
  const albumDir  = parts[1] || '';
  const fileName  = parts[2] ? path.basename(parts[2], path.extname(parts[2])) : path.basename(filePath, path.extname(filePath));

  // Album dir : "YYYY - Nom de l'album" ou "Nom de l'album"
  const albumDirMatch = albumDir.match(/^(\d{4})\s*-\s*(.+)$/);
  const year  = albumDirMatch ? albumDirMatch[1] : '';
  const album = albumDirMatch ? albumDirMatch[2].trim() : albumDir;

  // Nom de fichier : "01 - Artiste - Album - Titre"
  // Retirer le numéro de piste
  const noTrackNum = fileName.replace(/^\d+\s*[-\.]\s*/, '');

  // Retirer le préfixe artiste "Artiste - "
  let remainder = noTrackNum;
  const artistPrefix = artistDir + ' - ';
  if (remainder.toLowerCase().startsWith(artistPrefix.toLowerCase())) {
    remainder = remainder.slice(artistPrefix.length);
  }

  // Retirer le nom d'album "Album - " (en tenant compte des tirets dans le nom)
  let title = remainder;
  const albumPrefix = album + ' - ';
  if (remainder.toLowerCase().startsWith(albumPrefix.toLowerCase())) {
    title = remainder.slice(albumPrefix.length);
  }

  // Fallback : si title est vide, on prend le remainder complet
  if (!title) title = remainder || fileName;

  return {
    artist: artistDir,
    title:  title.trim(),
    album:  album.trim(),
    year,
  };
}

module.exports = { parseFromPath };
