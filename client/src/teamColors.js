/**
 * Classes Tailwind associées à chaque couleur d'équipe (attribuée côté serveur).
 * Les noms de classes sont écrits en toutes lettres pour que le JIT Tailwind les détecte.
 */
const TEAM_COLOR_CLASSES = {
  sky:     { dot: 'bg-sky-500',     badge: 'bg-sky-600 text-white',     soft: 'bg-sky-900/30 border-sky-700/40 text-sky-300' },
  emerald: { dot: 'bg-emerald-500', badge: 'bg-emerald-600 text-white', soft: 'bg-emerald-900/30 border-emerald-700/40 text-emerald-300' },
  amber:   { dot: 'bg-amber-500',   badge: 'bg-amber-600 text-white',   soft: 'bg-amber-900/30 border-amber-700/40 text-amber-300' },
  rose:    { dot: 'bg-rose-500',    badge: 'bg-rose-600 text-white',    soft: 'bg-rose-900/30 border-rose-700/40 text-rose-300' },
  violet:  { dot: 'bg-violet-500',  badge: 'bg-violet-600 text-white',  soft: 'bg-violet-900/30 border-violet-700/40 text-violet-300' },
  orange:  { dot: 'bg-orange-500',  badge: 'bg-orange-600 text-white',  soft: 'bg-orange-900/30 border-orange-700/40 text-orange-300' },
  cyan:    { dot: 'bg-cyan-500',    badge: 'bg-cyan-600 text-white',    soft: 'bg-cyan-900/30 border-cyan-700/40 text-cyan-300' },
  pink:    { dot: 'bg-pink-500',    badge: 'bg-pink-600 text-white',    soft: 'bg-pink-900/30 border-pink-700/40 text-pink-300' },
};

export function teamColorClasses(color) {
  return TEAM_COLOR_CLASSES[color] || TEAM_COLOR_CLASSES.sky;
}
