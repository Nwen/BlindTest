import { io } from 'socket.io-client';

// En développement, Vite proxifie vers localhost:3000.
// En production, l'origin est la même que le serveur.
// On ne renonce jamais à se reconnecter : un téléphone en veille ou un wifi qui
// saute peuvent couper la liaison plusieurs minutes, et le serveur garde la place
// du joueur (score, équipe) pendant tout ce temps.
const socket = io(window.location.origin, {
  autoConnect: true,
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
});

// Un onglet en arrière-plan voit ses timers gelés par le navigateur (surtout sur
// mobile) : la reconnexion programmée peut ne jamais partir. On la relance dès que
// la page revient au premier plan ou que le réseau est de retour.
function reconnectNow() {
  if (!socket.connected) socket.connect();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') reconnectNow();
});
window.addEventListener('online', reconnectNow);

export default socket;
