import { useState, useEffect } from 'react';

/**
 * Navigateur de fichiers locaux (bibliothèque musicale).
 *
 * onSelect(filePath, metadata) : appelé quand l'utilisateur sélectionne un fichier audio.
 * onClose                      : ferme la modal.
 */
export default function FileBrowser({ onSelect, onClose }) {
  const [currentDir, setCurrentDir] = useState('');
  const [items,      setItems]      = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState('');
  const [history,    setHistory]    = useState([]); // pile de navigation

  useEffect(() => {
    browse(undefined, true);
  }, []);

  async function browse(dir, isInit = false) {
    setLoading(true);
    setError('');
    try {
      const url = '/api/media/browse' + (dir ? `?dir=${encodeURIComponent(dir)}` : '');
      const res  = await fetch(url);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      if (!isInit && currentDir) {
        setHistory(h => [...h, currentDir]);
      }
      setCurrentDir(data.dir);
      setItems(data.items);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  function goBack() {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory(h => h.slice(0, -1));
    setLoading(true);
    fetch(`/api/media/browse?dir=${encodeURIComponent(prev)}`)
      .then(r => r.json())
      .then(data => {
        setCurrentDir(data.dir);
        setItems(data.items);
      })
      .finally(() => setLoading(false));
  }

  function handleItem(item) {
    if (item.isDir) {
      browse(item.path);
    } else if (item.isAudio) {
      onSelect(item.path);
    }
  }

  // Nom court du dossier courant
  const dirName = currentDir.split(/[\\/]/).pop() || 'Bibliothèque';

  return (
    <div className="fixed inset-0 bg-black/70 flex items-end sm:items-center justify-center z-50 p-2">
      <div className="bg-gray-800 rounded-2xl w-full max-w-lg max-h-[85vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-700">
          {history.length > 0 && (
            <button onClick={goBack} className="text-gray-400 hover:text-white p-1 rounded">
              ←
            </button>
          )}
          <span className="flex-1 text-sm font-medium truncate" title={currentDir}>
            {dirName}
          </span>
          <button onClick={onClose} className="text-gray-400 hover:text-white p-1 rounded">
            ✕
          </button>
        </div>

        {/* Corps */}
        <div className="overflow-y-auto flex-1 p-2">
          {loading && (
            <p className="text-gray-500 text-sm text-center py-8 animate-pulse">Chargement…</p>
          )}
          {error && (
            <p className="text-red-400 text-sm text-center py-4">{error}</p>
          )}
          {!loading && !error && items.length === 0 && (
            <p className="text-gray-500 text-sm text-center py-8">Dossier vide</p>
          )}
          {!loading && items.map((item) => (
            <button
              key={item.path}
              onClick={() => handleItem(item)}
              className={`w-full text-left flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-700 transition-colors ${
                item.isAudio ? 'text-green-300' : 'text-white'
              }`}
            >
              <span className="shrink-0 text-lg">
                {item.isDir ? '📁' : '🎵'}
              </span>
              <span className="truncate text-sm">{item.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
