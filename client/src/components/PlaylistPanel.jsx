import { useState } from 'react';

const STATUS_ICON = {
  pending:     '⏳',
  downloading: '⬇️',
  ready:       '✅',
  error:       '❌',
};

const STATUS_LABEL = {
  pending:     'En attente',
  downloading: 'Téléchargement…',
  ready:       'Prêt',
  error:       'Erreur',
};

/**
 * Panneau de gestion de la playlist pour le maître.
 *
 * playlist        : TrackInfo[]
 * currentIndex    : number
 * onAddYoutube(url)
 * onImportPlaylist(url)
 * onOpenBrowser()
 * onRemove(index)
 * onRetry(index)
 * onShuffle()
 * onPlay(index)
 */
export default function PlaylistPanel({
  playlist = [],
  currentIndex = -1,
  onAddYoutube,
  onImportPlaylist,
  onOpenBrowser,
  onRemove,
  onRetry,
  onShuffle,
  onPlay,
}) {
  const [ytUrl,   setYtUrl]   = useState('');
  const [plUrl,   setPlUrl]   = useState('');
  const [tab,     setTab]     = useState('list'); // 'list' | 'add'
  const [adding,  setAdding]  = useState(false);
  const [importing, setImporting] = useState(false);

  async function handleAddYt(e) {
    e.preventDefault();
    if (!ytUrl.trim()) return;
    setAdding(true);
    await onAddYoutube(ytUrl.trim());
    setYtUrl('');
    setAdding(false);
    setTab('list');
  }

  async function handleImport(e) {
    e.preventDefault();
    if (!plUrl.trim()) return;
    setImporting(true);
    await onImportPlaylist(plUrl.trim());
    setPlUrl('');
    setImporting(false);
    setTab('list');
  }

  return (
    <div className="flex flex-col h-full">
      {/* Onglets */}
      <div className="flex border-b border-gray-700 shrink-0">
        {[['list', 'Playlist'], ['add', 'Ajouter']].map(([t, label]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-2 text-xs font-medium transition-colors ${
              tab === t ? 'text-sky-400 border-b-2 border-sky-400' : 'text-gray-400 hover:text-white'
            }`}
          >
            {label} {t === 'list' ? `(${playlist.length})` : ''}
          </button>
        ))}
      </div>

      {/* Liste de pistes */}
      {tab === 'list' && (
        <div className="overflow-y-auto flex-1 space-y-1 p-2">
          {playlist.length > 1 && (
            <div className="flex justify-end px-1 pb-1">
              <button
                onClick={onShuffle}
                title="Mélanger l'ordre des pistes"
                className="text-xs text-gray-400 hover:text-white flex items-center gap-1 px-2 py-1
                           rounded transition-colors hover:bg-gray-700/50"
              >
                🔀 Mélanger
              </button>
            </div>
          )}
          {playlist.length === 0 && (
            <p className="text-gray-500 text-sm text-center py-6">
              Playlist vide — ajoute des pistes !
            </p>
          )}
          {playlist.map((track, i) => (
            <div
              key={track.id}
              className={`rounded-lg group transition-colors ${
                i === currentIndex ? 'bg-sky-900/40 border border-sky-700/40' : 'hover:bg-gray-700/50'
              }`}
            >
              <div className="flex items-center gap-2 px-2 py-2">
                <span className="text-xs text-gray-500 w-5 text-center shrink-0">{i + 1}</span>
                <span className="text-sm shrink-0" title={STATUS_LABEL[track.status]}>
                  {STATUS_ICON[track.status] || '?'}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white truncate font-medium">
                    {track.metadata?.title || '—'}
                  </p>
                  <p className="text-xs text-gray-400 truncate">
                    {track.metadata?.artist || (track.type === 'youtube' ? 'YouTube' : 'Local')}
                    {track.metadata?.year ? ` · ${track.metadata.year}` : ''}
                  </p>
                </div>
                <div className="flex gap-1 shrink-0">
                  {track.status === 'ready' && (
                    <button
                      onClick={() => onPlay(i)}
                      className="text-xs bg-sky-700 hover:bg-sky-600 text-white px-2 py-1 rounded transition-colors"
                    >
                      ▶
                    </button>
                  )}
                  {track.status === 'error' && track.type === 'youtube' && (
                    <button
                      onClick={() => onRetry(i)}
                      title="Réessayer le téléchargement"
                      className="text-xs bg-amber-700 hover:bg-amber-600 text-white px-2 py-1 rounded transition-colors"
                    >
                      ↻
                    </button>
                  )}
                  <button
                    onClick={() => onRemove(i)}
                    className="text-xs text-gray-500 hover:text-red-400 px-1 rounded transition-colors opacity-0 group-hover:opacity-100"
                  >
                    ✕
                  </button>
                </div>
              </div>
              {track.status === 'error' && track.error && (
                <p className="text-xs text-red-400 px-2 pb-2 -mt-1 break-words">
                  {track.error}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Ajouter des pistes */}
      {tab === 'add' && (
        <div className="flex-1 overflow-y-auto p-3 space-y-4">
          {/* Bibliothèque locale */}
          <section>
            <h3 className="text-xs text-gray-400 uppercase tracking-wide mb-2">Bibliothèque locale</h3>
            <button
              onClick={() => { onOpenBrowser(); setTab('list'); }}
              className="w-full flex items-center gap-3 px-3 py-3 bg-gray-700 hover:bg-gray-600
                         rounded-lg transition-colors text-sm text-left"
            >
              <span className="text-xl">📁</span>
              <span>Parcourir les fichiers…</span>
            </button>
          </section>

          {/* Ajouter une URL YouTube */}
          <section>
            <h3 className="text-xs text-gray-400 uppercase tracking-wide mb-2">URL YouTube</h3>
            <form onSubmit={handleAddYt} className="space-y-2">
              <input
                type="url"
                value={ytUrl}
                onChange={e => setYtUrl(e.target.value)}
                placeholder="https://www.youtube.com/watch?v=…"
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm
                           text-white placeholder-gray-500 focus:outline-none focus:border-sky-500"
              />
              <button
                type="submit"
                disabled={!ytUrl.trim() || adding}
                className="w-full bg-red-700 hover:bg-red-600 disabled:bg-gray-600 text-white
                           text-sm font-medium py-2 rounded-lg transition-colors"
              >
                {adding ? 'Ajout…' : 'Ajouter la vidéo'}
              </button>
            </form>
          </section>

          {/* Importer une playlist YouTube */}
          <section>
            <h3 className="text-xs text-gray-400 uppercase tracking-wide mb-2">Importer une playlist YouTube</h3>
            <form onSubmit={handleImport} className="space-y-2">
              <input
                type="url"
                value={plUrl}
                onChange={e => setPlUrl(e.target.value)}
                placeholder="https://www.youtube.com/playlist?list=…"
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm
                           text-white placeholder-gray-500 focus:outline-none focus:border-sky-500"
              />
              <button
                type="submit"
                disabled={!plUrl.trim() || importing}
                className="w-full bg-red-800 hover:bg-red-700 disabled:bg-gray-600 text-white
                           text-sm font-medium py-2 rounded-lg transition-colors"
              >
                {importing ? 'Import en cours…' : 'Importer la playlist'}
              </button>
            </form>
            <p className="text-xs text-gray-500 mt-1">
              Toutes les vidéos seront téléchargées en arrière-plan.
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
