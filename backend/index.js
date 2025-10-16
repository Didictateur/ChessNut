const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const fs = require('fs');
const LOGFILE = process.env.CHESSNUT_LOG || '/tmp/chessnut.log';
function appendLogLine(line){
  try{ fs.appendFileSync(LOGFILE, line + '\n'); }catch(e){}
}
function log(){
  const ts = new Date().toISOString();
  const msg = Array.prototype.slice.call(arguments).map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  const line = `${ts} ${msg}`;
  console.log(line);
  appendLogLine(line);
}

// Request logging middleware: logs method, path, small subset of headers and body
app.use((req, res, next) => {
  try{
    const { method, path } = req;
    const info = { method, path, headers: { origin: req.headers.origin, host: req.headers.host }, body: req.body };
    log('HTTP', info);
  }catch(e){}
  next();
});

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
  if(!g) {
    // log current games snapshot to help debugging
    try{
      const snapshot = games.map(x => ({ id: x.id, name: x.name, players: (x.players||[]).length, started: !!x.started }));
      log('start failed - game not found', { requestedId: id, gamesSnapshot: snapshot });
    }catch(e){ log('start failed - game not found (and failed to snapshot)'); }
    return res.status(404).json({ error: 'not found' });
  }
  if(g.pass && g.pass !== pass) return res.status(403).json({ error: 'bad password' });
  if(g.players.length >= 2) return res.status(403).json({ error: 'full' });
  const player = { id: 'p-' + Math.random().toString(36).slice(2,6), nickname: nickname || 'Anon', colorChoice: colorChoice || 'random', colorAssigned: null };
  player.connected = true;
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
  // do not allow leaving once game started
  if (g.started) return res.status(403).json({ error: 'game in progress' });
  // remove player (allowed only if game not started)
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
    // only prune if game has not started
    if (!g.started) {
      const idx = games.findIndex(x => x.id === id);
      if(idx !== -1) games.splice(idx, 1);
      return res.status(404).json({ error: 'not found' });
    }
  }
  res.json(g);
});

app.post('/api/start', (req, res) => {
  const { id } = req.body || {};
  log('POST /api/start', { id, body: req.body });
  const g = games.find(x => x.id === id);
  if(!g) return res.status(404).json({ error: 'not found' });
  if(g.players.length < 2) {
    log('start rejected: need 2 players', { gameId: id, players: g.players.map(p=>p.id) });
    return res.status(400).json({ error: 'need 2 players' });
  }
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
  // Initialize a minimal game.state to be consumed by frontend.
  // We avoid importing engine/ here: state is a plain JS structure describing the board.
  // Board is an 8x8 array of cells; each cell is either null or { color: 'white'|'black', type: 'PAWN'|'ROOK'|... }
  function initialState() {
    const w = 8, h = 8;
    const board = Array.from({ length: h }, () => Array.from({ length: w }, () => null));
    // pawns
    for (let x = 0; x < w; x++) {
      board[1][x] = { color: 'white', type: 'PAWN' };
      board[6][x] = { color: 'black', type: 'PAWN' };
    }
    // rooks
    board[0][0] = { color: 'white', type: 'ROOK' };
    board[0][7] = { color: 'white', type: 'ROOK' };
    board[7][0] = { color: 'black', type: 'ROOK' };
    board[7][7] = { color: 'black', type: 'ROOK' };
    // knights
    board[0][1] = { color: 'white', type: 'KNIGHT' };
    board[0][6] = { color: 'white', type: 'KNIGHT' };
    board[7][1] = { color: 'black', type: 'KNIGHT' };
    board[7][6] = { color: 'black', type: 'KNIGHT' };
    // bishops
    board[0][2] = { color: 'white', type: 'BISHOP' };
    board[0][5] = { color: 'white', type: 'BISHOP' };
    board[7][2] = { color: 'black', type: 'BISHOP' };
    board[7][5] = { color: 'black', type: 'BISHOP' };
    // queen/king
    board[0][3] = { color: 'white', type: 'QUEEN' };
    board[0][4] = { color: 'white', type: 'KING' };
    board[7][3] = { color: 'black', type: 'QUEEN' };
    board[7][4] = { color: 'black', type: 'KING' };

    return { board, width: w, height: h };
  }

  // only initialize if not already present
  if (!g.state) {
    g.state = initialState();
  }
  // set initial turn: white starts
  g.turn = 'white';
  log('start succeeded', { gameId: g.id, players: g.players.map(p => ({ id: p.id, nickname: p.nickname, colorAssigned: p.colorAssigned })) });
  io.to(g.id).emit('game-start', g);
  io.emit('games-list', games);
  res.json({ ok: true, game: g });
});

io.on('connection', (socket) => {
  log('socket connected', { socketId: socket.id, remote: socket.handshake && socket.handshake.address });
  socket.on('join-game', (gameId) => {
    const room = gameId;
    socket.join(room);
    log('join-game', { socketId: socket.id, room });
  });
  // client can identify which player it is in a game so server can map socket -> player
  socket.on('identify', (payload) => {
    try {
      const { gameId, playerId } = payload || {};
      if(gameId && playerId){
        socketMap.set(socket.id, { gameId, playerId });
        log('identify', { socketId: socket.id, gameId, playerId });
      }
    }catch(e){ }
  });
  socket.on('move', (payload) => {
    try {
      log('socket move', { socketId: socket.id, payload });
      const { gameId, playerId, from, to } = payload || {};
      const g = games.find(x => x.id === gameId);
      if (!g) return;

      // basic validation: must be started and it must be the player's turn
      if (!g.started) return;

      const player = g.players.find(p => p.id === playerId);
      if (!player) return;
      // determine player's color
      const color = player.colorAssigned || (player.colorChoice === 'white' ? 'white' : (player.colorChoice === 'black' ? 'black' : null));
      // if no assigned color (random choice), try to infer from players array
      if (!color) {
        if (g.players[0] && g.players[1]) {
          // if not assigned, assume assignment as in /api/start logic
          // fallback: first player white
        }
      }

      // ensure it is this player's turn (simple toggle 'white'/'black')
      if (g.turn && color && g.turn !== color) {
        // not this player's turn
        socket.emit('error', { error: 'not your turn' });
        return;
      }

      // bounds check and cell existence
      const h = g.state.height || g.state.board.length;
      const w = g.state.width || (g.state.board[0] && g.state.board[0].length) || 8;
      if (!from || !to) return;
      if (from.x < 0 || from.x >= w || from.y < 0 || from.y >= h) return;
      if (to.x < 0 || to.x >= w || to.y < 0 || to.y >= h) return;

      const src = g.state.board[from.y][from.x];
      if (!src) return; // no piece at source
      if (src.color !== color) { socket.emit('error', { error: 'not your piece' }); return; }

      // naive move apply: move piece from src to dest (no legality checks beyond ownership)
      const dst = g.state.board[to.y][to.x];
      // apply
      g.state.board[to.y][to.x] = src;
      g.state.board[from.y][from.x] = null;

      // toggle turn
      g.turn = g.turn === 'white' ? 'black' : 'white';

      io.to(gameId).emit('move', { gameId, playerId, from, to });
      io.to(gameId).emit('game-state', g.state);
    } catch (e) {
      console.error('move handler error', e && e.stack);
    }
  });

  socket.on('disconnect', (reason) => {
    const meta = socketMap.get(socket.id);
    log('socket disconnect', { socketId: socket.id, reason, meta });
    if(!meta) return;
    const { gameId, playerId } = meta;
    socketMap.delete(socket.id);
    const gIndex = games.findIndex(x => x.id === gameId);
    if(gIndex === -1) return;
    const g = games[gIndex];
    const pIndex = g.players.findIndex(p => p.id === playerId);
    if(pIndex === -1) return;
    const player = g.players[pIndex];
    // mark as disconnected instead of removing when game started
    if (g.started) {
      player.connected = false;
      console.log(`socket ${socket.id} disconnected (${reason}), marked player ${player.id} disconnected in ${gameId}`);
      io.to(gameId).emit('player-update', g);
      io.emit('games-list', games);
      return;
    }
    // if game not started, remove player as before
    const leaving = g.players.splice(pIndex, 1)[0];
    console.log(`socket ${socket.id} disconnected (${reason}), removed player ${leaving.id} from ${gameId}`);
    // if owner left and game not started, delete the game
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
