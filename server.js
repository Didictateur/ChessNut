const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const path = require('path');
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static('public'));
// Serve provided assets (piece sets, boards, etc.) under /assets
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// In-memory rooms store. For production replace with persistent store.
// room = { id, boardState: object|null, players: [{id, socketId, color}], status, size }
const rooms = new Map();

// Placeholder: compute legal moves for a square in the given room.
// `boardState` is the canonical JSON representation of the board for this server.
// Example boardState: { width:8, height:8, turn:'w', version:1, pieces: [{ square:'e2', type:'P', color:'w', id:'w_p1' }, ... ] }
function computeLegalMoves(room, square){
  // TODO: implement custom rules engine here. For now return empty list.
  return [];
}

function startingBoardState8(){
  // returns a simple pieces array with square names for standard chess starting position
  const rows = [
    'rnbqkbnr',
    'pppppppp',
    '........',
    '........',
    '........',
    '........',
    'PPPPPPPP',
    'RNBQKBNR'
  ];
  const pieces = [];
  for(let r=0;r<8;r++){
    const row = rows[r];
    for(let f=0;f<8;f++){
      const ch = row[f];
      if(ch === '.') continue;
      const fileLetter = String.fromCharCode('a'.charCodeAt(0) + f);
      const rank = 8 - r;
      const square = `${fileLetter}${rank}`;
      const isWhite = (ch === ch.toUpperCase());
      const type = ch.toUpperCase();
      const color = isWhite ? 'w' : 'b';
      const id = (color === 'w' ? 'w_' : 'b_') + type + '_' + pieces.length;
      pieces.push({ square, type, color, id });
    }
  }
  return { width: 8, height: 8, turn: 'w', version: 1, pieces };
}

app.post('/rooms', (req, res) => {
  const id = uuidv4().slice(0, 8);
  // allow optional board size in request body (default 8)
  const size = (req.body && parseInt(req.body.size, 10)) || 8;
  // For standard 8x8 we initialize a boardState JSON as the canonical board state.
  const boardState = size === 8 ? startingBoardState8() : null;
  // hostId will be set when the first player joins
  rooms.set(id, { id, boardState, players: [], status: 'waiting', hostId: null, size, cards: {}, playedCards: [], removalTimers: new Map() });
  res.json({ roomId: id, size });
});

app.get('/rooms/:id', (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: 'room not found' });
  const boardState = room.boardState || null;
  res.json({ id: room.id, boardState, size: room.size, players: room.players.map(p => ({ id: p.id, color: p.color })), status: room.status, hostId: room.hostId, cards: Object.keys(room.cards || {}) });
});

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  socket.on('room:join', ({ roomId, playerId }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb && cb({ error: 'room not found' });
  const assignedId = playerId || uuidv4();

    // If this player was pending removal (disconnect during navigation), cancel removal
    if(room.removalTimers && room.removalTimers.has(assignedId)){
      clearTimeout(room.removalTimers.get(assignedId));
      room.removalTimers.delete(assignedId);
    }

    // If playerId corresponds to an existing player, treat this as a reconnection
    let existing = room.players.find(p => p.id === assignedId);

    let color;
    if(existing){
      existing.socketId = socket.id;
      color = existing.color;
    } else {
      color = room.players.length === 0 ? 'white' : 'black';
      room.players.push({ id: assignedId, socketId: socket.id, color });
    }
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerId = assignedId;

    // set hostId when first player joins
    if (!room.hostId) room.hostId = assignedId;


    io.to(roomId).emit('room:update', {
      boardState: room.boardState || null,
      players: room.players.map(p => ({ id: p.id, color: p.color })),
      status: room.status,
      hostId: room.hostId,
      size: room.size,
      cards: Object.keys(room.cards || {})
    });

    cb && cb({ ok: true, color, roomId, playerId: assignedId, hostId: room.hostId });
  });

  socket.on('game:move', ({ roomId, from, to, promotion }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb && cb({ error: 'room not found' });

    // Move handling/validation is intentionally not implemented here.
    // Implement a function to validate & apply moves on the room.boardState and
    // then emit 'move:moved' with move details and updated room.boardState.
    return cb && cb({ error: 'move handling not implemented on server; implement custom engine' });
  });

  // Host can start the game explicitly
  socket.on('game:start', ({ roomId }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb && cb({ error: 'room not found' });

    // verify sender is the host (first player)
    const senderId = socket.data.playerId;
    if (!senderId) return cb && cb({ error: 'not joined' });
    if (room.players.length < 2) return cb && cb({ error: 'need 2 players to start' });
    // verify sender is the host (explicit hostId)
    if (!room.hostId || room.hostId !== senderId) return cb && cb({ error: 'only host can start' });

    room.status = 'playing';
    io.to(roomId).emit('game:started', { roomId, boardState: room.boardState });
    io.to(roomId).emit('room:update', {
      boardState: room.boardState || null,
      players: room.players.map(p => ({ id: p.id, color: p.color })),
      status: room.status,
      hostId: room.hostId,
      size: room.size,
      cards: Object.keys(room.cards || {})
    });

    cb && cb({ ok: true });
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    // delay removal to allow fast reconnects (e.g. navigation between pages)
    const playerId = socket.data.playerId;
    if(playerId && room.removalTimers){
      const t = setTimeout(()=>{
          room.players = room.players.filter(p => p.id !== playerId);
        // if the host left, promote the next player to host (or null)
        if (room.hostId && !room.players.find(p => p.id === room.hostId)) {
          room.hostId = room.players[0] ? room.players[0].id : null;
        }
        if (room.players.length < 2 && room.status === 'playing') room.status = 'waiting';
        io.to(roomId).emit('room:update', {
          boardState: room.boardState || null,
          players: room.players.map(p => ({ id: p.id, color: p.color })),
          status: room.status,
          hostId: room.hostId,
          size: room.size,
          cards: Object.keys(room.cards || {})
        });
        room.removalTimers.delete(playerId);
      }, 5000);
      room.removalTimers.set(playerId, t);
    } else {
      // fallback: immediate removal
      room.players = room.players.filter(p => p.socketId !== socket.id);
      if (room.players.length < 2 && room.status === 'playing') room.status = 'waiting';
      if (room.hostId && !room.players.find(p => p.id === room.hostId)) {
        room.hostId = room.players[0] ? room.players[0].id : null;
      }
      io.to(roomId).emit('room:update', {
        boardState: room.boardState || null,
        players: room.players.map(p => ({ id: p.id, color: p.color })),
        status: room.status,
        hostId: room.hostId,
        size: room.size,
        cards: Object.keys(room.cards || {})
      });
    }
  });

  // delegates to `computeLegalMoves` which is a stub you should implement.
  socket.on('game:legalMoves', ({ roomId, square }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb && cb({ error: 'room not found' });
    try{
      const moves = computeLegalMoves(room, square) || [];
      return cb && cb({ ok: true, moves });
    }catch(e){
      console.error('game:legalMoves error', e);
      return cb && cb({ error: 'invalid square', moves: [] });
    }
  });

  // Simple cards API via sockets: list/play
  socket.on('card:list', ({ roomId }, cb) => {
    const room = rooms.get(roomId);
    if(!room) return cb && cb({ error: 'room not found' });
    // return available card types (placeholder)
    const available = [
      { id: 'invert', name: 'Invert Turn', description: 'Swap movement directions for one move' },
      { id: 'teleport', name: 'Teleport', description: 'Move one piece to any empty square' }
    ];
    cb && cb({ ok: true, cards: available });
  });

  socket.on('card:play', ({ roomId, playerId, cardId, payload }, cb) => {
    const room = rooms.get(roomId);
    if(!room) return cb && cb({ error: 'room not found' });
    // store played card (placeholder behaviour) and broadcast
    const played = { id: uuidv4().slice(0,8), playerId, cardId, payload, ts: Date.now() };
    room.playedCards = room.playedCards || [];
    room.playedCards.push(played);
    io.to(roomId).emit('card:played', played);
    cb && cb({ ok: true, played });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`ChessNut server listening on port ${PORT}`);
});
