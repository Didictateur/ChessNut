const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static('public'));

// In-memory rooms store. For production replace with persistent store.
// room = { id, chess: Chess, players: [{id, socketId, color}], status }
const rooms = new Map();

app.post('/rooms', (req, res) => {
  const id = uuidv4().slice(0, 8);
  const chess = new Chess();
  rooms.set(id, { id, chess, players: [], status: 'waiting' });
  res.json({ roomId: id });
});

app.get('/rooms/:id', (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: 'room not found' });
  res.json({ id: room.id, fen: room.chess.fen(), players: room.players.map(p => ({ id: p.id, color: p.color })), status: room.status });
});

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  socket.on('room:join', ({ roomId, playerId }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb && cb({ error: 'room not found' });
    if (room.players.length >= 2) return cb && cb({ error: 'room full' });

    const assignedId = playerId || uuidv4();
    const color = room.players.length === 0 ? 'white' : 'black';
    room.players.push({ id: assignedId, socketId: socket.id, color });
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerId = assignedId;


    io.to(roomId).emit('room:update', {
      fen: room.chess.fen(),
      players: room.players.map(p => ({ id: p.id, color: p.color })),
      status: room.status
    });

    cb && cb({ ok: true, color, roomId, playerId: assignedId });
  });

  socket.on('game:move', ({ roomId, from, to, promotion }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb && cb({ error: 'room not found' });

    const chess = room.chess;

    // Validate move
    const move = chess.move({ from, to, promotion });
    if (!move) return cb && cb({ error: 'invalid move' });

    io.to(roomId).emit('move:moved', { move, fen: chess.fen() });

    if (chess.isGameOver()) {
      room.status = 'finished';
      let result = 'draw';
      if (chess.isCheckmate()) result = 'checkmate';
      else if (chess.isStalemate()) result = 'stalemate';
      io.to(roomId).emit('game:over', { result, fen: chess.fen() });
    }

    cb && cb({ ok: true, move, fen: chess.fen() });
  });

  // Host can start the game explicitly
  socket.on('game:start', ({ roomId }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb && cb({ error: 'room not found' });

    // verify sender is the host (first player)
    const senderId = socket.data.playerId;
    if (!senderId) return cb && cb({ error: 'not joined' });
    if (room.players.length < 2) return cb && cb({ error: 'need 2 players to start' });
    const host = room.players[0];
    if (!host || host.id !== senderId) return cb && cb({ error: 'only host can start' });

    room.status = 'playing';
    io.to(roomId).emit('game:started', { roomId, fen: room.chess.fen() });
    io.to(roomId).emit('room:update', {
      fen: room.chess.fen(),
      players: room.players.map(p => ({ id: p.id, color: p.color })),
      status: room.status
    });

    cb && cb({ ok: true });
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    room.players = room.players.filter(p => p.socketId !== socket.id);
    if (room.players.length < 2 && room.status === 'playing') room.status = 'waiting';

    io.to(roomId).emit('room:update', {
      fen: room.chess.fen(),
      players: room.players.map(p => ({ id: p.id, color: p.color })),
      status: room.status
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`ChessNut server listening on port ${PORT}`);
});
