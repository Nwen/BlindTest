# BlindTest

Application de blind test musical multi-joueurs, jouable en LAN ou en ligne : un·e maître du jeu (MJ) contrôle la partie depuis un panneau dédié, les joueurs rejoignent avec un code de room et devinent artiste/titre en temps réel.

## Stack

- **Serveur** — Node.js (CommonJS), Express, Socket.io
- **Client** — React + Vite + Tailwind CSS
- **Audio** — fichiers locaux (streaming HTTP avec range requests) ou pistes YouTube (téléchargées à la volée via yt-dlp)
- **Déploiement** — Docker / docker-compose

## Fonctionnement du jeu

1. Le MJ crée une partie (`create-game`) et obtient un code de room à 4 caractères ainsi qu'un token de reconnexion.
2. Les joueurs rejoignent avec le code et un pseudo (`join-game`).
3. Le MJ construit la playlist en parcourant la bibliothèque locale (`master:add-local`) et/ou en ajoutant des liens YouTube (`master:add-youtube`, `master:import-playlist`).
4. Pour chaque piste : `master:play` → les joueurs répondent → `master:stop` → `master:reveal` affiche les résultats → le MJ attribue les points → `master:next` passe à la piste suivante.
5. Phases de la partie : `lobby → playing → stopped → results` (boucle piste par piste jusqu'à la fin de la playlist).

Si le MJ se déconnecte, la partie est conservée 5 minutes pour lui permettre de se reconnecter avec son token.

### Modes de jeu

Le MJ choisit le mode entre deux pistes (`master:set-mode`, impossible pendant `playing`) :

- **Texte** (par défaut) — les joueurs tapent artiste/titre (`submit-answer`). Barème : 1 pt artiste, 1 pt titre, 3 pts les deux. Le MJ attribue les points via des toggles (`master:award`).
- **Buzzer** — les joueurs appuient sur un bouton pour buzzer (`buzz`) ; le serveur horodate chaque buzz et diffuse le classement en direct (`buzz-update`). Le MJ juge la réponse à l'oral et attribue librement un nombre de points par joueur ou par équipe entière (`master:buzzer-award`).

### Équipes

Le MJ peut créer des équipes (`master:create-team`), en supprimer (`master:delete-team`) et y assigner des joueurs (`master:assign-team`, indépendant du mode de jeu). Une équipe a une couleur attribuée automatiquement et le classement affiche le score cumulé de ses membres. En mode buzzer, dès qu'un membre d'une équipe buzze, le buzzer se verrouille pour le reste de l'équipe le temps du round (une seule tentative par équipe).

## Prérequis

- Node.js 20+
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) et `ffmpeg` accessibles dans le PATH (pour l'ajout de pistes YouTube)
- Une bibliothèque musicale locale organisée en `artist/année - album/piste - artist - album - titre.ext`

## Configuration

Copier `.env.example` vers `.env` et renseigner :

| Variable             | Description                                                              |
|----------------------|---------------------------------------------------------------------------|
| `PORT`               | Port d'écoute du serveur (`docker-compose` : port publié sur l'hôte)      |
| `MUSIC_LIBRARY_PATH` | Chemin absolu, sur l'hôte, vers la bibliothèque musicale (monté en lecture seule dans le conteneur) |
| `MEDIA_ROOT`          | Racine de la bibliothèque *vue par le serveur* (`/media` en Docker, chemin local en dev) |

## Développement local

```bash
# Serveur
cd server
npm install
MEDIA_ROOT="C:\chemin\vers\musique" npm start   # http://localhost:3000

# Client (dans un autre terminal)
cd client
npm install
npm run dev                                      # http://localhost:5173, proxy vers le serveur
```

## Déploiement avec Docker

```bash
cp .env.example .env
# éditer .env : PORT, MUSIC_LIBRARY_PATH

docker compose up -d --build
```

Le conteneur construit le client (Vite) puis sert le bundle statique depuis le serveur Express ; l'API et les WebSockets sont exposés sur `PORT` (32001 par défaut). Un volume nommé (`yt-cache`) persiste le cache des téléchargements YouTube entre redémarrages.

## Structure du projet

```
server/
  index.js            Serveur Express + tous les handlers Socket.io
  GameManager.js       État du jeu (rooms, joueurs, scoring)
  routes/media.js       Parcours + streaming des fichiers locaux
  routes/youtube.js     Wrapper yt-dlp (téléchargement, recherche, playlists)
  utils/parseMedia.js   Parsing d'un chemin de fichier → {artist, title, album, year}
client/
  src/pages/Home.jsx        Écran d'accueil (créer / rejoindre une partie)
  src/pages/MasterView.jsx  Panneau de contrôle du MJ
  src/pages/PlayerView.jsx  Vue joueur (réponses / buzzer pendant la musique)
  src/components/           Scoreboard, FileBrowser, PlaylistPanel, TeamManager, BuzzerPanel
```

## API HTTP

- `GET /api/health` — healthcheck
- `GET /api/media/browse?dir=<chemin>` — parcours de la bibliothèque locale
- `GET /api/media/stream?path=<chemin>` — streaming audio (range requests)
- `/api/youtube/*` — recherche, info et téléchargement de pistes YouTube
