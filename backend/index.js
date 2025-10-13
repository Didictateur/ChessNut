const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 4000;

// simple in-memory storage (not persisted)
const games = [];
// map socket.id -> { gameId, playerId }
const socketMap = new Map();

app.post('/api/create', (req, res) => {
  console.log('[backend] POST /api/create received', req.body && { name: req.body.name, owner: req.body.ownerNickname });
  const id = 'game-' + Math.random().toString(36).slice(2,9);
  const { name, pass, ownerNickname, ownerColorChoice } = req.body || {};
  const g = {
    id,
    name: name || id,
    pass: pass || null,
    created: Date.now(),
    players: [],
    started: false,
    options: { startWhenTwo: true }
  };
  // add owner as first player if provided
  let ownerPlayer = null;
  if(ownerNickname){
    ownerPlayer = { id: 'p-' + Math.random().toString(36).slice(2,6), nickname: ownerNickname, colorChoice: ownerColorChoice || 'random', colorAssigned: null };
    g.players.push(ownerPlayer);
    // explicit owner id for robust ownership checks
    g.ownerId = ownerPlayer.id;
  }
  games.push(g);
  io.emit('games-list', games);
  // return game and owner player if present so frontend can persist player id
  if(ownerPlayer) return res.json({ ok: true, game: g, player: ownerPlayer });
  res.json({ ok: true, game: g });
});

app.get('/api/list', (req, res) => {
  // remove any orphan games (no players)
  for (let i = games.length - 1; i >= 0; i--) {
    const g = games[i];
    if(!g.players || g.players.length === 0){
      games.splice(i, 1);
    }
  }
  res.json(games);
});

// remove previously created test games (names used during local testing)
app.post('/api/cleanup-tests', (req, res) => {
  const patterns = [/^test$/i, /^curl-test$/i, /^start-test$/i];
  const before = games.length;
  for (let i = games.length - 1; i >= 0; i--) {
    const g = games[i];
    if (patterns.some(p => p.test(g.name))) {
      games.splice(i, 1);
    }
  }
  const removed = before - games.length;
  io.emit('games-list', games);
  res.json({ ok: true, removed });
});

function pruneOrphans(){
  let removed = 0;
  for (let i = games.length - 1; i >= 0; i--) {
    const g = games[i];
    if(!g.players || g.players.length === 0){ games.splice(i,1); removed++; }
  }
  if(removed) io.emit('games-list', games);
  return removed;
}

// allow manual prune via api for dev
app.post('/api/prune-orphans', (req, res) => {
  const removed = pruneOrphans();
  res.json({ ok: true, removed });
});

// dev helper: delete game(s) by exact name
app.post('/api/delete-by-name', (req, res) => {
  const { name } = req.body || {};
  if(!name) return res.status(400).json({ error: 'name required' });
  const before = games.length;
  for (let i = games.length - 1; i >= 0; i--) {
    if (games[i].name === name) games.splice(i,1);
  }
  const removed = before - games.length;
  if(removed) io.emit('games-list', games);
  res.json({ ok: true, removed });
});

// dev helper: delete a game by id
app.post('/api/delete-by-id', (req, res) => {
  const { id } = req.body || {};
  if(!id) return res.status(400).json({ error: 'id required' });
  const idx = games.findIndex(g => g.id === id);
  if(idx === -1) return res.status(404).json({ error: 'not found' });
  games.splice(idx, 1);
  io.emit('games-list', games);
  res.json({ ok: true, removed: 1 });
});

// periodic prune every minute
setInterval(() => { pruneOrphans(); }, 60 * 1000);

app.post('/api/join', (req, res) => {
  const { id, pass, nickname, colorChoice } = req.body || {};
  const g = games.find(x => x.id === id);
  if(!g) return res.status(404).json({ error: 'not found' });
  if(g.pass && g.pass !== pass) return res.status(403).json({ error: 'bad password' });
  if(g.players.length >= 2) return res.status(403).json({ error: 'full' });
  const player = { id: 'p-' + Math.random().toString(36).slice(2,6), nickname: nickname || 'Anon', colorChoice: colorChoice || 'random', colorAssigned: null };
  g.players.push(player);
  io.to(g.id).emit('player-update', g);
  io.emit('games-list', games);
  res.json({ ok: true, game: g, player });
});

// leave a game: payload { gameId, playerId }
app.post('/api/leave', (req, res) => {
  const { gameId, playerId } = req.body || {};
  const gIndex = games.findIndex(x => x.id === gameId);
  if(gIndex === -1) return res.status(404).json({ error: 'not found' });
  const g = games[gIndex];
  const pIndex = g.players.findIndex(p => p.id === playerId);
  if(pIndex === -1) return res.status(404).json({ error: 'player not in game' });
  // remove player
  const leaving = g.players.splice(pIndex, 1)[0];
  // if the leaving player was the owner, remove the entire game
  if(g.ownerId && leaving.id === g.ownerId){
    games.splice(gIndex, 1);
    io.emit('games-list', games);
    io.to(gameId).emit('game-deleted', { gameId });
    return res.json({ ok: true, deleted: true });
  }
  io.to(gameId).emit('player-update', g);
  io.emit('games-list', games);
  res.json({ ok: true, game: g });
});

app.get('/api/game/:id', (req, res) => {
  const id = req.params.id;
  const g = games.find(x => x.id === id);
  if(!g) return res.status(404).json({ error: 'not found' });
  // if game exists but has no players, treat as not found and remove it
  if(!g.players || g.players.length === 0){
    const idx = games.findIndex(x => x.id === id);
    if(idx !== -1) games.splice(idx, 1);
    return res.status(404).json({ error: 'not found' });
  }
  res.json(g);
});

app.post('/api/start', (req, res) => {
  const { id } = req.body || {};
  const g = games.find(x => x.id === id);
  if(!g) return res.status(404).json({ error: 'not found' });
  if(g.players.length < 2) return res.status(400).json({ error: 'need 2 players' });
  // assign colors
  const p0 = g.players[0];
  const p1 = g.players[1];
  function assign(){
    // if one chose white and other chose black, honor
    if(p0.colorChoice === 'white' && p1.colorChoice === 'black'){ p0.colorAssigned = 'white'; p1.colorAssigned = 'black'; return; }
    if(p0.colorChoice === 'black' && p1.colorChoice === 'white'){ p0.colorAssigned = 'black'; p1.colorAssigned = 'white'; return; }
    // if one fixed and other random, honor fixed
    if(p0.colorChoice === 'white' || p0.colorChoice === 'black'){ p0.colorAssigned = p0.colorChoice; p1.colorAssigned = (p0.colorChoice === 'white' ? 'black' : 'white'); return; }
    if(p1.colorChoice === 'white' || p1.colorChoice === 'black'){ p1.colorAssigned = p1.colorChoice; p0.colorAssigned = (p1.colorChoice === 'white' ? 'black' : 'white'); return; }
    // otherwise random
    if(Math.random() < 0.5){ p0.colorAssigned = 'white'; p1.colorAssigned = 'black'; } else { p0.colorAssigned = 'black'; p1.colorAssigned = 'white'; }
  }
  assign();
  g.started = true;
  io.to(g.id).emit('game-start', g);
  io.emit('games-list', games);
  res.json({ ok: true, game: g });
});

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);
  socket.on('join-game', (gameId) => {
    const room = gameId;
    socket.join(room);
    console.log(`${socket.id} joined room ${room}`);
  });
  // client can identify which player it is in a game so server can map socket -> player
  socket.on('identify', (payload) => {
    try {
      const { gameId, playerId } = payload || {};
      if(gameId && playerId){
        socketMap.set(socket.id, { gameId, playerId });
        console.log(`socket ${socket.id} identified as player ${playerId} in ${gameId}`);
      }
    }catch(e){ }
  });
  socket.on('move', (payload) => {
    const { gameId } = payload;
    socket.to(gameId).emit('move', payload);
  });

  socket.on('disconnect', (reason) => {
    // if we know which player this socket belonged to, remove them from the game
    const meta = socketMap.get(socket.id);
    if(!meta) return;
    const { gameId, playerId } = meta;
    socketMap.delete(socket.id);
    const gIndex = games.findIndex(x => x.id === gameId);
    if(gIndex === -1) return;
    const g = games[gIndex];
    const pIndex = g.players.findIndex(p => p.id === playerId);
    if(pIndex === -1) return;
    const leaving = g.players.splice(pIndex, 1)[0];
    console.log(`socket ${socket.id} disconnected (${reason}), removed player ${leaving.id} from ${gameId}`);
    // if owner left, delete the game
    if(g.ownerId && leaving.id === g.ownerId){
      games.splice(gIndex, 1);
      io.emit('games-list', games);
      io.to(gameId).emit('game-deleted', { gameId });
      return;
    }
    io.to(gameId).emit('player-update', g);
    io.emit('games-list', games);
  });
});

server.listen(PORT, () => console.log(`backend listening ${PORT}`));
