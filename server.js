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

const rooms = {};   // code -> { players:[{id,name,seat}], state, forced:{seat:value} }

const code = () => Math.random().toString(36).slice(2, 6).toUpperCase();

// Never send the "forced" info to normal players.
function publicState(room) {
  return { players: room.players.map(({ name, seat }) => ({ name, seat })), state: room.state };
}

io.on('connection', socket => {
  socket.isAdmin = false;

  socket.on('createRoom', ({ name }, cb) => {
    const c = code();
    rooms[c] = { players: [{ id: socket.id, name, seat: 0 }], state: null, forced: {} };
    socket.join(c); socket.room = c;
    cb && cb({ ok: true, room: c, seat: 0 });
  });

  socket.on('joinRoom', ({ room, name }, cb) => {
    const r = rooms[room];
    if (!r || r.state) return cb && cb({ ok: false, error: 'room not available' });
    if (r.players.length >= 4) return cb && cb({ ok: false, error: 'room full' });
    const seat = [0, 1, 2, 3].find(x => !r.players.some(p => p.seat === x));
    r.players.push({ id: socket.id, name, seat });
    socket.join(room); socket.room = room;
    io.to(room).emit('lobby', publicState(r));
    cb && cb({ ok: true, room, seat });
  });

  socket.on('startGame', () => {
    const r = rooms[socket.room];
    if (!r || r.players[0].id !== socket.id || r.players.length < 2) return;
    r.state = game.createGame(r.players.map(p => p.seat));
    io.to(socket.room).emit('state', publicState(r));
  });

  socket.on('rollDice', () => {
    const r = rooms[socket.room];
    if (!r || !r.state) return;
    const me = r.players.find(p => p.id === socket.id);
    const cur = r.state.players[r.state.turn];
    if (!me || me.seat !== cur.seat) return;           // not your turn
    const forced = r.forced[me.seat];
    delete r.forced[me.seat];                           // one-time use
    const res = game.rollDice(r.state, forced);
    io.to(socket.room).emit('rolled', { ...res, state: r.state });
  });

  socket.on('moveToken', ({ token }) => {
    const r = rooms[socket.room];
    if (!r || !r.state) return;
    const me = r.players.find(p => p.id === socket.id);
    const cur = r.state.players[r.state.turn];
    if (!me || me.seat !== cur.seat) return;
    const res = game.moveToken(r.state, token);
    io.to(socket.room).emit('moved', { ...res, state: r.state });
  });

  // ---------- Admin ----------
  socket.on('admin:login', ({ secret }, cb) => {
    socket.isAdmin = secret === ADMIN_SECRET;
    cb && cb({ ok: socket.isAdmin });
  });

  socket.on('admin:listRooms', (_, cb) => {
    if (!socket.isAdmin) return;
    cb && cb(Object.entries(rooms).map(([c, r]) => ({
      room: c, players: r.players.map(p => ({ name: p.name, seat: p.seat })),
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
    if (p) io.sockets.sockets.get(p.id)?.disconnect(true);
  });

  socket.on('disconnect', () => {
    const r = rooms[socket.room];
    if (!r) return;
    r.players = r.players.filter(p => p.id !== socket.id);
    if (r.players.length === 0) delete rooms[socket.room];
    else io.to(socket.room).emit('lobby', publicState(r));
  });
});

server.listen(process.env.PORT || 3000, () => console.log('Ludo server on port', process.env.PORT || 3000));
