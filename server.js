// Ludo multiplayer server: rooms, turns, admin dice control.
// Run: npm install && ADMIN_SECRET=yourpassword node server.js
const http = require('http');
const { Server } = require('socket.io');
const game = require('./game');

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-me';
const fs = require('fs');
const path = require('path');
// Serve the game screen (index.html) at "/"; Socket.IO serves its own client script.
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url.startsWith('/?')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
  }
  if (req.url === '/admin') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(__dirname, 'admin.html')).pipe(res);
  }
  const STATIC = {
    '/manifest.json': ['manifest.json', 'application/manifest+json'],
    '/admin-manifest.json': ['admin-manifest.json', 'application/manifest+json'],
    '/sw.js': ['sw.js', 'application/javascript'],
    '/icon-192.png': ['icon-192.png', 'image/png'],
    '/icon-512.png': ['icon-512.png', 'image/png'],
    '/admin-icon-192.png': ['admin-icon-192.png', 'image/png'],
    '/admin-icon-512.png': ['admin-icon-512.png', 'image/png'],
  };
  const f = STATIC[req.url.split('?')[0]];
  if (f) {
    res.writeHead(200, { 'Content-Type': f[1] });
    return fs.createReadStream(path.join(__dirname, f[0])).pipe(res);
  }
  res.writeHead(404); res.end('Not found');
});
const io = new Server(server, { cors: { origin: '*' } });


const rooms = {};   // code -> { players:[{id,token,name,seat,connected,offlineAt}], state, forced:{seat:value}, local }
const COLOR_NAMES = ['Red', 'Green', 'Yellow', 'Blue'];

const code = () => Math.random().toString(36).slice(2, 6).toUpperCase();
const newToken = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

// Never send the "forced" info to normal players.
function publicState(room) {
  return {
    players: room.players.map(({ name, seat, connected }) => ({ name, seat, connected })),
    state: room.state,
  };
}

// One player (or, in "one phone" mode, one device) in a room, by socket.
const seatsOf = (r, socket) => r.players.filter(p => p.id === socket.id);

io.on('connection', socket => {
  socket.isAdmin = false;

  socket.on('createRoom', ({ name, local, count }, cb) => {
    const c = code();
    const token = newToken();
    if (local) {
      // One phone, 2-4 players. This device controls every seat.
      const n = Math.min(4, Math.max(2, parseInt(count, 10) || 2));
      const seats = n === 2 ? [0, 2] : [...Array(n).keys()];
      rooms[c] = {
        local: true, forced: {},
        players: seats.map(s => ({ id: socket.id, token, name: COLOR_NAMES[s], seat: s, connected: true })),
        state: game.createGame(seats),
      };
      socket.join(c); socket.room = c;
      cb && cb({ ok: true, room: c, seat: seats[0], local: true, token });
      socket.emit('state', publicState(rooms[c]));
      return;
    }
    rooms[c] = { players: [{ id: socket.id, token, name, seat: 0, connected: true }], state: null, forced: {} };
    socket.join(c); socket.room = c;
    cb && cb({ ok: true, room: c, seat: 0, token });
  });

  socket.on('joinRoom', ({ room, name }, cb) => {
    const r = rooms[room];
    if (!r || r.state || r.local) return cb && cb({ ok: false, error: 'room not available' });
    if (r.players.length >= 4) return cb && cb({ ok: false, error: 'room full' });
    const seat = [0, 1, 2, 3].find(x => !r.players.some(p => p.seat === x));
    const token = newToken();
    r.players.push({ id: socket.id, token, name, seat, connected: true });
    socket.join(room); socket.room = room;
    io.to(room).emit('lobby', publicState(r));
    cb && cb({ ok: true, room, seat, token });
  });

  // Come back after the phone slept / the network dropped / the page was reloaded.
  socket.on('rejoin', ({ room, token }, cb) => {
    const r = rooms[room];
    const mine = r && token ? r.players.filter(p => p.token === token) : [];
    if (!mine.length || mine.some(p => p.banned)) return cb && cb({ ok: false });
    mine.forEach(p => { p.id = socket.id; p.connected = true; delete p.offlineAt; });
    socket.join(room); socket.room = room;
    cb && cb({ ok: true, room, seat: mine[0].seat, local: !!r.local, started: !!r.state });
    if (r.state) socket.emit('state', publicState(r));
    io.to(room).emit('lobby', publicState(r));
  });

  socket.on('startGame', () => {
    const r = rooms[socket.room];
    if (!r || r.state || r.players[0].id !== socket.id || r.players.length < 2) return;
    r.state = game.createGame(r.players.map(p => p.seat));
    io.to(socket.room).emit('state', publicState(r));
  });

  socket.on('rollDice', () => {
    const r = rooms[socket.room];
    if (!r || !r.state) return;
    const cur = r.state.players[r.state.turn];
    const me = r.players.find(p => p.id === socket.id && p.seat === cur.seat);
    if (!me) return;                                    // not your turn
    const forced = r.forced[me.seat];
    delete r.forced[me.seat];                           // one-time use
    const res = game.rollDice(r.state, forced);
    io.to(socket.room).emit('rolled', { ...res, state: r.state });
  });

  socket.on('moveToken', ({ token }) => {
    const r = rooms[socket.room];
    if (!r || !r.state) return;
    const cur = r.state.players[r.state.turn];
    const me = r.players.find(p => p.id === socket.id && p.seat === cur.seat);
    if (!me) return;
    const res = game.moveToken(r.state, token);
    io.to(socket.room).emit('moved', { ...res, state: r.state });
  });

  // Emoji reactions (whitelisted, rate-limited)
  const REACTS = ['😂', '😎', '😡', '👏', '🔥', '😭'];
  socket.on('react', ({ e }) => {
    const r = rooms[socket.room];
    if (!r || !r.state || !REACTS.includes(e)) return;
    const me = r.players.find(p => p.id === socket.id);
    const now = Date.now();
    if (!me || now - (socket.lastReact || 0) < 700) return;
    socket.lastReact = now;
    io.to(socket.room).emit('react', { seat: me.seat, e });
  });

  // ---------- Admin ----------
  socket.on('admin:login', ({ secret }, cb) => {
    socket.isAdmin = secret === ADMIN_SECRET;
    cb && cb({ ok: socket.isAdmin });
  });

  socket.on('admin:listRooms', (_, cb) => {
    if (!socket.isAdmin) return;
    cb && cb(Object.entries(rooms).map(([c, r]) => ({
      room: c, players: r.players.map(p => ({ name: p.name, seat: p.seat, connected: p.connected })),
      local: !!r.local,
      forced: r.forced, started: !!r.state, turnSeat: r.state ? r.state.players[r.state.turn].seat : null,
    })));
  });

  // Set the NEXT dice value for a seat in a room.
  socket.on('admin:setDice', ({ room, seat, value }, cb) => {
    if (!socket.isAdmin || !rooms[room]) return;
    rooms[room].forced[seat] = value;
    cb && cb({ ok: true });
  });

  socket.on('admin:kick', ({ room, seat }) => {
    if (!socket.isAdmin || !rooms[room]) return;
    const p = rooms[room].players.find(x => x.seat === seat);
    if (!p) return;
    rooms[room].players.filter(x => x.token === p.token).forEach(x => { x.banned = true; });
    io.sockets.sockets.get(p.id)?.disconnect(true);
  });

  // A dropped connection never removes a player: they are marked offline and can rejoin.
  socket.on('disconnect', () => {
    const r = rooms[socket.room];
    if (!r) return;
    seatsOf(r, socket).forEach(p => { p.connected = false; p.offlineAt = Date.now(); });
    io.to(socket.room).emit('lobby', publicState(r));
  });
});

// Housekeeping, every 3 seconds:
//  - if the player whose turn it is has been offline for 45s, play their turn for them
//    (so the others are not stuck waiting). Not used in one-phone rooms.
//  - delete rooms where everyone has been offline for 30 minutes.
setInterval(() => {
  const now = Date.now();
  for (const [c, r] of Object.entries(rooms)) {
    if (r.players.every(p => p.connected === false) &&
        now - Math.max(...r.players.map(p => p.offlineAt || 0)) > 30 * 60 * 1000) {
      delete rooms[c];
      continue;
    }
    if (r.local || !r.state || r.state.winners.length >= r.state.players.length - 1) continue;
    const cur = r.state.players[r.state.turn];
    const p = r.players.find(x => x.seat === cur.seat);
    if (!p || p.connected !== false || now - (p.offlineAt || now) < 45000) continue;

    if (!r.state.rolled) {
      const forced = r.forced[p.seat]; delete r.forced[p.seat];
      const res = game.rollDice(r.state, forced);
      io.to(c).emit('rolled', { ...res, state: r.state });
      if (res.passed) continue;
    }
    const moves = game.legalMoves(r.state);
    if (!moves.length) continue;
    const mv = game.moveToken(r.state, moves[Math.floor(Math.random() * moves.length)]);
    io.to(c).emit('moved', { ...mv, state: r.state });
  }
}, 3000);

server.listen(process.env.PORT || 3000, () => console.log('Ludo server on port', process.env.PORT || 3000));
