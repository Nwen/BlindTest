import { io } from 'socket.io-client';

// En développement, Vite proxifie vers localhost:3000.
// En production, l'origin est la même que le serveur.
const socket = io(window.location.origin, {
  autoConnect: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 1000,
});

export default socket;
