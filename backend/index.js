const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const fs = require('fs');
const path = require('path');
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
// map `${gameId}:${playerId}` -> timeoutId for pending disconnects
const pendingDisconnects = new Map();

function pdKey(gameId, playerId){ return `${gameId}:${playerId}`; }

// Diagnostic helper: attempt to dynamically import the engine GameState module
async function tryImportEngine(){
  const candidates = [];
  // common possibilities inside container /app
  candidates.push(path.join(__dirname, 'engine', 'core', 'game_state.js'));
  candidates.push(path.resolve(__dirname, '../engine/core/game_state.js'));
  candidates.push('/app/engine/core/game_state.js');
  candidates.push('/engine/core/game_state.js');

  const attemptErrors = {};
  for (const candidate of candidates) {
    try {
      const urlStr = 'file://' + candidate;
      const mod = await import(urlStr);
      log('tryImportEngine: import OK', { tried: candidate, keys: Object.keys(mod) });
      return { ok: true, mod, tried: candidate };
    } catch (e) {
      attemptErrors[candidate] = (e && e.stack) || String(e);
    }
  }

  // if we get here, all attempts failed — gather snippets from likely engine dir(s)
  const files = ['game_state.js','board.js','piece.js','cell.js'];
  const snippets = {};
  const probeDirs = [path.join(__dirname, 'engine', 'core'), path.resolve(__dirname, '../engine/core'), '/app/engine/core', '/engine/core'];
  for (const d of probeDirs) {
    for (const f of files) {
      const p = path.join(d, f);
      try { const txt = fs.readFileSync(p, 'utf8'); snippets[p] = txt.slice(0, 2000); } catch(err) { snippets[p] = `read-failed: ${err && err.message}`; }
    }
  }
  log('tryImportEngine: all attempts failed', { attempts: Object.keys(attemptErrors).length, attemptErrors: Object.keys(attemptErrors).reduce((acc,k)=>{acc[k]=attemptErrors[k].split('\n')[0];return acc;},{}) });
  try{ fs.writeFileSync('/tmp/chessnut-engine-import-error.log', JSON.stringify({ time: new Date().toISOString(), attemptErrors, snippets }, null, 2)); }catch(err){}
  // try fallback by running engine-loader.mjs (ESM) via node
  try{
    const loaderRes = await runEngineLoader();
    log('tryImportEngine: runEngineLoader result', { loaderRes });
    if(loaderRes && loaderRes.ok) return { ok: true, loader: loaderRes };
  }catch(e){ log('tryImportEngine: runEngineLoader failed', { err: e && e.stack || e }); }

  return { ok: false, error: attemptErrors, snippets };
}

// Fallback: try to run engine-loader.mjs via node (spawn) to let node use ESM loader
const { spawnSync } = require('child_process');

async function runEngineLoader(){
  try{
    const loaderPath = path.join(__dirname, 'engine-loader.mjs');
    const res = spawnSync('node', [loaderPath], { encoding: 'utf8', maxBuffer: 200000 });
    if(res.error){ return { ok:false, error: res.error.message }; }
    if(res.status !== 0){
      return { ok:false, stdout: res.stdout, stderr: res.stderr, status: res.status };
    }
    try{ const j = JSON.parse(res.stdout || '{}'); return { ok:true, result: j, raw: res.stdout }; }catch(e){ return { ok:true, raw: res.stdout }; }
  }catch(e){ return { ok:false, error: e && e.stack }; }
}

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
  // clear any pending disconnect timer for this player
  const key = pdKey(gameId, playerId);
  if(pendingDisconnects.has(key)){ clearTimeout(pendingDisconnects.get(key)); pendingDisconnects.delete(key); }
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

app.post('/api/start', async (req, res) => {
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
  // Safety: if both players somehow received the same color (bug/regression), force distinct colors
  try{
    if (p0.colorAssigned && p1.colorAssigned && p0.colorAssigned === p1.colorAssigned) {
      log('api/start: duplicate colorAssigned detected, forcing distinct assignment', { gameId: g.id, p0: p0.id, p1: p1.id, current: p0.colorAssigned });
      p0.colorAssigned = 'white';
      p1.colorAssigned = 'black';
    }
  }catch(e){ log('api/start: safety assignment check failed', { err: e && e.stack }); }
  // Notify clients about players/colors immediately
  try{ io.to(g.id).emit('player-update', g); }catch(e){ log('failed to emit player-update after assign', { err: e && e.stack }); }
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
    // attempt to import engine GameState for richer state; on failure we log detailed diagnostics
    const importResult = await tryImportEngine();
    if (importResult.ok) {
      try {
        const GameState = importResult.mod && (importResult.mod.default || importResult.mod.GameState);
        if (typeof GameState === 'function') {
          const gs = new GameState();
          g._engineState = gs;
          // best-effort serialize
          try{
            const serialized = (typeof gs.getBoard === 'function') ? (function(){
              // serialize Board -> plain structure { board: [rows], width, height }
              const boardObj = gs.getBoard();
              const w = (typeof boardObj.getWidth === 'function') ? boardObj.getWidth() : (boardObj.width || 8);
              const h = (typeof boardObj.getHeight === 'function') ? boardObj.getHeight() : (boardObj.height || 8);
              const board = Array.from({ length: h }, (v, y) => Array.from({ length: w }, (v2, x) => {
                try {
                  const cell = (typeof boardObj.getCell === 'function') ? boardObj.getCell(x, y) : (boardObj.grid && boardObj.grid[y] && boardObj.grid[y][x]);
                  if (!cell || !cell.piece) return null;
                  const p = cell.piece;
                  const color = (typeof p.getColor === 'function' ? p.getColor() : p.color) || p.color;
                  const type = (typeof p.getType === 'function' ? p.getType() : p.type) || p.type;
                  return { color: String(color).toLowerCase(), type: String(type).toUpperCase() };
                } catch (e) { return null; }
              }));
              return { board, width: w, height: h };
            })() : null;
            g.state = serialized || initialState();
          }catch(e){ log('engine serialization failed, falling back', { err: e && e.stack }); g.state = initialState(); }
        } else {
          log('imported engine module does not expose GameState constructor, falling back to plain state');
          g.state = initialState();
        }
      } catch(e){ log('failed to instantiate GameState, falling back', { err: e && e.stack }); g.state = initialState(); }
    } else {
      // import failed: return 500 with short message, detailed info written to logs/file by tryImportEngine
      log('api/start aborting due to engine import failure', { gameId: g.id });
      return res.status(500).json({ error: 'engine import failed - see server logs' });
    }
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
        // if this player had a pending disconnect timer, cancel it and mark reconnected
        const key = pdKey(gameId, playerId);
        if(pendingDisconnects.has(key)){
          clearTimeout(pendingDisconnects.get(key));
          pendingDisconnects.delete(key);
          // mark player as connected again and notify others
          const g = games.find(x => x.id === gameId);
          if(g){
            const p = g.players.find(p => p.id === playerId);
            if(p){ p.connected = true; io.to(gameId).emit('player-update', g); io.emit('games-list', games); }
          }
        }
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
    // remove mapping for this socket immediately
    socketMap.delete(socket.id);
    // schedule a delayed removal: if the player doesn't reconnect within 3s, consider them left
    const key = pdKey(gameId, playerId);
    if(pendingDisconnects.has(key)){
      clearTimeout(pendingDisconnects.get(key));
      pendingDisconnects.delete(key);
    }
    const t = setTimeout(() => {
      // perform removal after grace period
      const gIndex = games.findIndex(x => x.id === gameId);
      if(gIndex === -1){ pendingDisconnects.delete(key); return; }
      const g = games[gIndex];
      const pIndex = g.players.findIndex(p => p.id === playerId);
      if(pIndex === -1){ pendingDisconnects.delete(key); return; }
      const player = g.players[pIndex];
      // remove player regardless of started state (user asked players away >3s are considered left)
      const leaving = g.players.splice(pIndex, 1)[0];
      log('delayed remove player', { gameId, playerId: leaving.id, owner: g.ownerId });
      // if owner left, remove entire game immediately
      if(g.ownerId && leaving.id === g.ownerId){
        games.splice(gIndex, 1);
        io.emit('games-list', games);
        io.to(gameId).emit('game-deleted', { gameId });
        pendingDisconnects.delete(key);
        return;
      }
      io.to(gameId).emit('player-update', g);
      io.emit('games-list', games);
      pendingDisconnects.delete(key);
    }, 3000);
    pendingDisconnects.set(key, t);
  });
});

server.listen(PORT, () => console.log(`backend listening ${PORT}`));
