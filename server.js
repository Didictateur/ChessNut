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

// Send a room:update payload to each player individually so hands remain private.
function sendRoomUpdate(room){
  if(!room) return;
  const base = {
    boardState: room.boardState || null,
    players: (room.players || []).map(p => ({ id: p.id, color: p.color })),
    status: room.status,
    hostId: room.hostId,
    size: (room.boardState && room.boardState.width) || room.size,
    cards: Object.keys(room.cards || {}),
    deckCount: (room.deck && room.deck.length) || 0,
    discardCount: (room.discard && room.discard.length) || 0
  };

  const handCounts = {};
  (room.players || []).forEach(p => { handCounts[p.id] = (room.hands && room.hands[p.id] ? room.hands[p.id].length : 0); });

  (room.players || []).forEach(p => {
    const payload = Object.assign({}, base, {
      // expose only the recipient's own hand
      handsOwn: (room.hands && room.hands[p.id]) ? room.hands[p.id] : [],
      handCounts
    });
    if(p.socketId){
      io.to(p.socketId).emit('room:update', payload);
    }
  });
}

// Build a default deck from README list. Each card has a unique id, cardId (slug), title and description.
function buildDefaultDeck(){
  const cards = [
    // ['tronquer le plateau','Tronque au maximum le plateau sans supprimer de pièce'],
    ['rebondir sur les bords','Les déplacements en diagonales de la pièce sélectionnée peuvent rebondir une fois sur les bords'],
    ['agrandir le plateau','Rajoute une rangée dans toutes les directions'],
  ['adoubement','La pièce sélectionnée peut maintenant faire les déplacements du cavalier en plus'],
  ['folie','La pièce sélectionnée peut maintenant faire les déplacements du fou en plus'],
  ['fortification','La pièce sélectionnée peut maintenant faire les déplacements de la tour en plus'],
    ['fortification','La pièce sélectionnée peut maintenant faire les déplacements de la tour en plus'],
    // ["l'anneau","Le plateau devient un anneau pendant un tour"],
    // ['brouillard de guerre','Les joueur ne peuvent voir que au alentour de leurs pièces pendant X tours'],
    // ['changer la pièce à capturer','Le joueur choisie la nouvelle pièce jouant le rôle de roi sans la révéler'],
    // ['trou de ver','Deux cases du plateau deviennent maintenant la même'],
    // ['jouer deux fois','Le joueur peut déplacer deux pièces'],
    // ['annulation d une carte','Annule l effet d une carte qui est jouée par l adversaire'],
    // ['placement de mines','Le joueur place une mine sur une case vide sans la révéler au joueur adverse. Une pièce qui se pose dessus explose et est capturée par le joueur ayant placé la mine'],
    // ['vole d une pièce','Désigne une pièce non roi qui change de camp'],
    // ['promotion','Un pion au choix est promu reine'],
    // ['vole d une carte','Vole une carte aléatoirement au joueur adverse'],
    // ['resurection','Choisie une pièce capturée pour la ressuciter dans son camp'],
    // ['carte sans effet','N a aucun effet'],
    // ['défausse','Le joueur adverse défausse une carte de son choix'],
    // ['immunité à la capture','Désigne une pièce qui ne pourra pas être capturée au prochain tour'],
    // ['kamikaz','Détruit une de ses pièces, détruisant toutes les pièces adjacentes'],
    // ['retour à la case départ','Désigne une pièce qui retourne à sa position initiale'],
    // ['glissade','La pièce désignée ne peut plus s arrêter si elle se déplace en diagonale ou en ligne droite. Soit elle percute une pièce et la capture, soit elle tombe du plateau et est capturée'],
    // ['invisible','Une des pièces devient invisible pour l adversaire'],
    // ['épidémie','Toutes les pièces sur le territoire enemie est est capturée'],
    // ['glue','Toutes les pièces autour de la pièce désignée ne peuvent pas bouger tant que cette dernière ne bouge pas'],
    // ['coin coin','Possibilité de se téléporter depuis  un coin vers n importe quel autre coin'],
    // ['téléportation','Téléporte n importe quelle pièce de son camp sur une case vide'],
    // ['changement de camp','On retourne le plateau'],
    // ['ça tangue','Toutes les pièces se décale du même côté'],
    // ['réinitialisation','Toutes les pièces reviennent à leur position initiale. S il y a des pièces supplémenaires, se rangent devant les pions'],
    // ['toucher c est jouer','Toucher une pièce adverse qu il sera obligé de jouer si elle existe encore lors de son tour'],
    // ['marécage','Pendant X tours, toutes les pièces ne peuvent se déplacer que comme un roi'],
    // ['sniper','Capturer une pièce sans avoir à bouger la pièce capturante'],
    // ['inversion','Échange la position d une pièce avec une pièce adverse'],
    // ['jeu des 7 différences','Déplace une pièce du plateau pendant que le joueur adverse à les yeux fermés. S il la retrouve, elle est capturée, laissée sinon'],
    // ['punching ball','Replace le roi dans sa position initiale, et place un nouveau pion à l ancienne position du roi'],
    // ['reversi','Si deux pions encadrent parfaitement une pièce adverse, cette dernière change de camp'],
    // ['plus on est de fous','Si le joueur possède deux fous dans la même diagonale, alors toutes les pièces adverses encadrées par ces deux fous sont capturés'],
    // ['cluster','Désigne 4 pions formant un rectangle. Tant que ces pions ne bougent pas, aucune pièce ne peut sortir ou rentrer dans ce rectangle.'],
    // ['vacances','Choisie une pièce qui sort du plateau pendant deux tours. Ce après quoi elle tente de revenir: si la case est occupée, alors la pièce vacancière est capturée par la pièce occupant la case.'],
    // ['mélange','La position de toutes les pièces sont échangées aléatoirement.'],
    // ['la parrure','Une reine est dégradée en pion'],
    // ['tricherie','Regarde les trois prochaines cartes de la pioche.'],
    // ['tout ou rien','Une pièce choisie ne peut maintenant se déplacer que si elle capture.'],
    // ['tous les mêmes','Au yeux de l ennemie, toutes les pièces se ressemblent pendant 2 tours.'],
    // ['petit pion','Le joueur choisit un pion. À partir du prochain tour, il est promu en reine dès qu il capture un pièce non pion.'],
    // ['révolution','Tous les pions sont aléatoirement changés en Cavalier, Fou ou Tour et les Cavaliers, Fous et Tours sont changés en pions.'],
    // ['doppelganger','Choisis une pièce. À partir de maintenant, devient chacune des pièces qu elle capture.'],
    // ['kurby','Choisis une pièce. À sa prochaine capture, récupère les mouvements de la pièce capturée.']
  ];
  function cap(s){ if(!s) return s; s = String(s).trim(); return s.charAt(0).toUpperCase() + s.slice(1); }
  return cards.map(([title,desc])=>{
    const normalized = (title||'').toString().trim();
    const cardId = normalized.replace(/[^a-z0-9]+/gi,'_').toLowerCase();
    return { id: uuidv4().slice(0,8), cardId, title: cap(normalized), description: desc };
  });
}

// draw a random card from room.deck and assign to player hand (respect max hand size 5)
function drawCardForPlayer(room, playerId){
  if(!room) return null;
  // ensure deck exists for legacy rooms
  room.deck = room.deck || buildDefaultDeck();
  room.hands = room.hands || {};
  room.deck = room.deck || [];
  const hand = room.hands[playerId] || [];
  // avoid drawing more than once for the same board version
  room._lastDrawForPlayer = room._lastDrawForPlayer || {};
  const boardVersion = (room.boardState && room.boardState.version) || null;
  if(boardVersion !== null && room._lastDrawForPlayer[playerId] === boardVersion){
    // already drew for this version
    return null;
  }
  if(hand.length >= 5) return null; // hand full
  if(room.deck.length === 0){
    // if deck empty, try to refill from discard and shuffle
    if(room.discard && room.discard.length > 0){
      // move all discard into deck
      room.deck = room.discard.splice(0).concat(room.deck || []);
      // simple Fisher-Yates shuffle
      for(let i = room.deck.length - 1; i > 0; i--){
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = room.deck[i]; room.deck[i] = room.deck[j]; room.deck[j] = tmp;
      }
      // notify players that the deck was reshuffled
      (room.players || []).forEach(p => { if(p.socketId) io.to(p.socketId).emit('deck:reshuffled', { roomId: room.id, deckCount: room.deck.length }); });
    }
  }
  if(room.deck.length === 0) return null; // no cards even after reshuffle
  // pick random index
  const idx = Math.floor(Math.random() * room.deck.length);
  const card = room.deck.splice(idx,1)[0];
  // normalize title capitalization just in case this deck was created earlier with inconsistent casing
  if(card && card.title){
    card.title = String(card.title).trim();
    card.title = card.title.charAt(0).toUpperCase() + card.title.slice(1);
  }
  room.hands[playerId] = room.hands[playerId] || [];
  room.hands[playerId].push(card);
  if(boardVersion !== null) room._lastDrawForPlayer[playerId] = boardVersion;
  // emit card drawn and updated room state
  // send card:drawn only to the recipient
  const recipient = (room.players || []).find(p => p.id === playerId);
  if(recipient && recipient.socketId){
    io.to(recipient.socketId).emit('card:drawn', { playerId, card });
  }
  // send personalized room updates to all players
  sendRoomUpdate(room);
  return card;
}
// Placeholder: compute legal moves for a square in the given room.
// `boardState` is the canonical JSON representation of the board for this server.
// Example boardState: { width:8, height:8, turn:'w', version:1, pieces: [{ square:'e2', type:'P', color:'w', id:'w_p1' }, ... ] }
function computeLegalMoves(room, square){
  // Basic pseudo-legal move generator for standard chess-like pieces.
  // - Does not perform check detection (moves that leave king in check are allowed).
  // - Does not implement castling or en-passant.
  // - Returns moves as array of { from, to }.
  if(!room || !room.boardState || !square) return [];
  const state = room.boardState;
  const width = state.width || 8;
  const height = state.height || 8;

  // helpers
  function squareToCoord(sq){
    if(!sq) return null;
    const s = String(sq).trim().toLowerCase();
    if(!/^[a-z][1-9][0-9]*$/.test(s)) return null;
    const file = s.charCodeAt(0) - 'a'.charCodeAt(0);
    const rank = parseInt(s.slice(1),10) - 1; // 0-indexed
    return { x: file, y: rank };
  }
  function coordToSquare(x,y){
    if(x < 0 || y < 0 || x >= width || y >= height) return null;
    return String.fromCharCode('a'.charCodeAt(0) + x) + (y+1);
  }
  function getPieceAt(sq){
    if(!sq) return null;
    return (state.pieces || []).find(p => p.square === sq) || null;
  }
  function isInside(x,y){ return x >= 0 && y >= 0 && x < width && y < height; }

  const piece = getPieceAt(square);
  if(!piece) return [];
  const color = piece.color; // 'w' or 'b'
  const fromCoord = squareToCoord(square);
  if(!fromCoord) return [];
  const moves = [];

  // add move helper
  function pushIfEmptyOrCapture(tx,ty){
    if(!isInside(tx,ty)) return false;
    const toSq = coordToSquare(tx,ty);
    const occupant = getPieceAt(toSq);
    if(!occupant){
      moves.push({ from: square, to: toSq });
      return true; // can continue sliding
    }
    // capture allowed if different color
    if(occupant.color !== color){
      moves.push({ from: square, to: toSq });
    }
    return false; // blocked
  }

  const x = fromCoord.x, y = fromCoord.y;
  const type = (piece.type || '').toUpperCase();
  // detect if this specific piece has a permanent adoubement effect (grants knight moves)
  // effects may be bound either to the piece's current square or to the piece id (preferred)
  const hasAdoubement = (room.activeCardEffects || []).some(e => e.type === 'adoubement' && ((e.pieceId && e.pieceId === piece.id) || e.pieceSquare === square));

  // helper to add knight (N) deltas when a piece has been adoubé
  function addAdoubementMoves(){
    if(!hasAdoubement) return;
    const deltas = [[1,2],[2,1],[-1,2],[-2,1],[1,-2],[2,-1],[-1,-2],[-2,-1]];
    deltas.forEach(([dx,dy])=>{
      const tx = x + dx, ty = y + dy;
      if(!isInside(tx,ty)) return;
      const tsq = coordToSquare(tx,ty);
      // avoid duplicates
      if(moves.some(m => m.to === tsq)) return;
      const occ = getPieceAt(tsq);
      if(!occ || occ.color !== color) moves.push({ from: square, to: tsq });
    });
  }
  // detect if this specific piece has a permanent folie effect (grants bishop moves)
  const hasFolie = (room.activeCardEffects || []).some(e => e.type === 'folie' && ((e.pieceId && e.pieceId === piece.id) || e.pieceSquare === square));

  // detect if this specific piece has a permanent fortification effect (grants rook moves)
  const hasFortification = (room.activeCardEffects || []).some(e => e.type === 'fortification' && ((e.pieceId && e.pieceId === piece.id) || e.pieceSquare === square));

  // helper to add diagonal sliding moves when a piece has been "folié"
  function addFolieMoves(){
    if(!hasFolie) return;
    const dirs = [[1,1],[1,-1],[-1,1],[-1,-1]];
    dirs.forEach(([dx,dy])=>{
      let tx = x + dx, ty = y + dy;
      while(isInside(tx,ty)){
        const tsq = coordToSquare(tx,ty);
        // avoid duplicates
        if(!moves.some(m => m.to === tsq)){
          const occ = getPieceAt(tsq);
          if(!occ){ moves.push({ from: square, to: tsq }); }
          else { if(occ.color !== color) moves.push({ from: square, to: tsq }); break; }
        } else {
          // if duplicate found, still need to stop sliding if occupied
          const occ = getPieceAt(tsq);
          if(occ) break;
        }
        tx += dx; ty += dy;
      }
    });
  }
  // helper to add orthogonal sliding moves when a piece has been 'fortifié'
  function addFortificationMoves(){
    if(!hasFortification) return;
    const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
    dirs.forEach(([dx,dy])=>{
      let tx = x + dx, ty = y + dy;
      while(isInside(tx,ty)){
        const tsq = coordToSquare(tx,ty);
        if(!moves.some(m => m.to === tsq)){
          const occ = getPieceAt(tsq);
          if(!occ){ moves.push({ from: square, to: tsq }); }
          else { if(occ.color !== color) moves.push({ from: square, to: tsq }); break; }
        } else {
          const occ = getPieceAt(tsq);
          if(occ) break;
        }
        tx += dx; ty += dy;
      }
    });
  }
  if(type === 'P'){
    // pawn
    const forward = (color === 'w') ? 1 : -1;
    const startRank = (color === 'w') ? 1 : (height - 2);
    const oneY = y + forward;
    const oneSq = coordToSquare(x, oneY);
    if(isInside(x, oneY) && !getPieceAt(oneSq)){
      moves.push({ from: square, to: oneSq });
      // double push from starting rank
      const twoY = y + forward*2;
      const twoSq = coordToSquare(x, twoY);
      if(y === startRank && isInside(x, twoY) && !getPieceAt(twoSq)){
        moves.push({ from: square, to: twoSq });
      }
    }
    // captures
    [[x-1, y+forward],[x+1, y+forward]].forEach(([tx,ty])=>{
      if(!isInside(tx,ty)) return;
      const tsq = coordToSquare(tx,ty);
      const occ = getPieceAt(tsq);
      if(occ && occ.color !== color) moves.push({ from: square, to: tsq });
    });
    addAdoubementMoves(); addFolieMoves(); addFortificationMoves();
    return moves;
  }

  if(type === 'N'){
    const deltas = [[1,2],[2,1],[-1,2],[-2,1],[1,-2],[2,-1],[-1,-2],[-2,-1]];
    deltas.forEach(([dx,dy])=>{
      const tx = x + dx, ty = y + dy;
      if(!isInside(tx,ty)) return;
      const tsq = coordToSquare(tx,ty);
      const occ = getPieceAt(tsq);
      if(!occ || occ.color !== color) moves.push({ from: square, to: tsq });
    });
    addAdoubementMoves(); addFolieMoves(); addFortificationMoves();
    return moves;
  }

  if(type === 'B' || type === 'Q' || type === 'R'){
    const directions = [];
    if(type === 'B' || type === 'Q') directions.push([1,1],[1,-1],[-1,1],[-1,-1]);
    if(type === 'R' || type === 'Q') directions.push([1,0],[-1,0],[0,1],[0,-1]);

  // detect if this specific piece has an active rebondir effect (match by id or square)
  const hasRebond = (room.activeCardEffects || []).some(e => e.type === 'rebondir' && ((e.pieceId && e.pieceId === piece.id) || e.pieceSquare === square));

    directions.forEach(([dx0,dy0])=>{
      if(!hasRebond){
        // standard sliding behavior
        let tx = x + dx0, ty = y + dy0;
        while(isInside(tx,ty)){
          const cont = pushIfEmptyOrCapture(tx,ty);
          if(!cont) break;
          tx += dx0; ty += dy0;
        }
      } else {
        // sliding with a single bounce on edges (mirror reflection once)
        let dx = dx0, dy = dy0;
        let cx = x, cy = y; // current position while sliding
        let bounced = false;
        while(true){
          let tx = cx + dx, ty = cy + dy;
          if(!isInside(tx,ty)){
            if(bounced) break; // already used bounce
            // reflect the direction components that would go out of bounds
            if(tx < 0 || tx >= width) dx = -dx;
            if(ty < 0 || ty >= height) dy = -dy;
            bounced = true;
            // recompute the next square after reflection from current position
            tx = cx + dx; ty = cy + dy;
            if(!isInside(tx,ty)) break; // still invalid after reflection
          }
          const tsq = coordToSquare(tx,ty);
          const occ = getPieceAt(tsq);
          if(!occ){
            moves.push({ from: square, to: tsq });
            // advance current position along the (possibly reflected) direction
            cx = tx; cy = ty;
            continue;
          }
          // occupied
          if(occ.color !== color) moves.push({ from: square, to: tsq });
          break;
        }
      }
    });
    addAdoubementMoves(); addFolieMoves(); addFortificationMoves();
    return moves;
  }

  if(type === 'K'){
    for(let dx=-1; dx<=1; dx++) for(let dy=-1; dy<=1; dy++){
      if(dx === 0 && dy === 0) continue;
      const tx = x + dx, ty = y + dy;
      if(!isInside(tx,ty)) continue;
      const tsq = coordToSquare(tx,ty);
      const occ = getPieceAt(tsq);
      if(!occ || occ.color !== color) moves.push({ from: square, to: tsq });
    }
    addAdoubementMoves(); addFolieMoves();
    return moves;
  }

  addAdoubementMoves(); addFolieMoves(); addFortificationMoves();
  return moves;
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
  // initialize a deck for this room
  const deck = buildDefaultDeck();
  rooms.set(id, { id, boardState, players: [], status: 'waiting', hostId: null, size, cards: {}, playedCards: [], removalTimers: new Map(), deck, hands: {} });
  res.json({ roomId: id, size });
});

app.get('/rooms/:id', (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: 'room not found' });
    const boardState = room.boardState || null;
    const size = (room.boardState && room.boardState.width) || room.size;
  res.json({ id: room.id, boardState, size: size, players: room.players.map(p => ({ id: p.id, color: p.color })), status: room.status, hostId: room.hostId, cards: Object.keys(room.cards || {}) });
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
    // ensure hands map exists
    room.hands = room.hands || {};
    // ensure deck exists for legacy rooms
    if(!room.deck) room.deck = buildDefaultDeck();
    // Note: starter card removed. Previously the first joining player received an 'Agrandir le plateau' starter card here.
    // The starter card was removed to avoid duplicate/unused cards in gameplay.
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerId = assignedId;

    // set hostId when first player joins
    if (!room.hostId) room.hostId = assignedId;


    sendRoomUpdate(room);

    // If the game is already playing and it's this player's turn, attempt to draw (useful on reconnect)
    // Only draw if the player's hand is currently empty to avoid double-drawing (e.g. initial granted cards)
    try{
      if(room.status === 'playing' && room.boardState && room.boardState.turn){
        const myPlayer = room.players.find(p => p.id === assignedId);
        const myShort = (myPlayer && myPlayer.color || '')[0];
        if(myShort === room.boardState.turn){
          const hasHand = room.hands && room.hands[assignedId] && room.hands[assignedId].length > 0;
          if(!hasHand) drawCardForPlayer(room, assignedId);
        }
      }
    }catch(e){ console.error('post-join draw error', e); }
    cb && cb({ ok: true, color, roomId, playerId: assignedId, hostId: room.hostId });
  });

  socket.on('game:move', ({ roomId, from, to, promotion }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb && cb({ error: 'room not found' });
    // Basic move handling: validate turn, validate piece ownership, validate target is one of computeLegalMoves,
    // apply the move to room.boardState, handle captures, flip turn and broadcast the updated board.
    try{
      const senderId = socket.data.playerId;
      if(!senderId) return cb && cb({ error: 'not joined' });
      const roomPlayer = room.players.find(p => p.id === senderId);
      if(!roomPlayer) return cb && cb({ error: 'player not in room' });
      if(!room.boardState) return cb && cb({ error: 'no board state' });

      const board = room.boardState;
      // determine player's color short form ('w'|'b')
      const playerColorShort = (roomPlayer.color && roomPlayer.color[0]) || null;
      if(!playerColorShort) return cb && cb({ error: 'invalid player color' });

      // must be player's turn
      if(board.turn !== playerColorShort) return cb && cb({ error: 'not your turn' });

      // find piece at 'from'
      const pieces = board.pieces || [];
      const moving = pieces.find(p => p.square === from);
      if(!moving) return cb && cb({ error: 'no piece at source' });
      if(moving.color !== playerColorShort) return cb && cb({ error: 'not your piece' });

      // validate that 'to' is among legal moves
      const legal = computeLegalMoves(room, from) || [];
      const ok = legal.some(m => m.to === to);
      if(!ok) return cb && cb({ error: 'illegal move' });

      // apply move: remove any piece on target (capture)
      const targetIndex = pieces.findIndex(p => p.square === to);
      if(targetIndex >= 0){
        // remove captured piece
        pieces.splice(targetIndex, 1);
      }
      // move the piece
      moving.square = to;

      // consume any active card effects bound to this piece (rebondir is one-time and should be removed)
      // also update any persistent effects (like adoubement) to track the piece's new square so they remain active
      try{
        room.activeCardEffects = room.activeCardEffects || [];
        // iterate backwards so we can splice safely
        for(let i = room.activeCardEffects.length - 1; i >= 0; i--){
          const e = room.activeCardEffects[i];
          // remove one-time rebondir if it refers to this piece (by pieceId or by its old square)
          if(e.type === 'rebondir' && (e.pieceSquare === from || (e.pieceId && e.pieceId === moving.id))){
            room.activeCardEffects.splice(i,1);
            continue;
          }
          // if the effect is bound to the piece id, update its recorded square so the effect persists after moves
          if(e.pieceId && e.pieceId === moving.id){
            e.pieceSquare = to;
          }
        }
      }catch(e){ console.error('consuming card effects error', e); }

      // advance version and flip turn
      board.version = (board.version || 0) + 1;
      board.turn = (board.turn === 'w') ? 'b' : 'w';

      // at this point the board has been updated and the turn flipped
      // determine next player and perform their draw BEFORE broadcasting the move, so the draw happens at the start of their turn
      const moved = { playerId: senderId, from, to, boardState: board };
      try{
        const nextColor = board.turn; // 'w' or 'b'
        const nextPlayer = room.players.find(p => (p.color && p.color[0]) === nextColor);
        if(nextPlayer){
          // draw for next player (this will emit card:drawn privately and send personalized room:update)
          drawCardForPlayer(room, nextPlayer.id);
        } else {
          // ensure room state is broadcast
          sendRoomUpdate(room);
        }
      }catch(e){
        console.error('draw-at-start-of-turn error', e);
      }

      // now broadcast the move to all clients (move event separate from room:update)
      io.to(roomId).emit('move:moved', moved);

      return cb && cb({ ok: true, moved });
    }catch(err){
      console.error('game:move error', err);
      return cb && cb({ error: 'server error' });
    }
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
    sendRoomUpdate(room);

    // draw initial card for the player to move (beginning of their turn)
    // If the player already has a card (for instance the special starter card), skip the automatic draw
    try{
      if(room.boardState && room.boardState.turn){
        const firstColor = room.boardState.turn; // 'w' or 'b'
        const firstPlayer = room.players.find(p => (p.color && p.color[0]) === firstColor);
        if(firstPlayer){
          const hasHand = room.hands && room.hands[firstPlayer.id] && room.hands[firstPlayer.id].length > 0;
          if(!hasHand) drawCardForPlayer(room, firstPlayer.id);
        }
      }
    }catch(e){
      console.error('initial draw error', e);
    }

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
        sendRoomUpdate(room);
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
      sendRoomUpdate(room);
    }
  });

  // delegates to `computeLegalMoves` which is a stub you should implement.
  // legalMoves API removed (movement UI disabled)
  // Re-add legalMoves API to compute and return pseudo-legal moves for a square.
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

  // propagate selection made by one client to the other clients in the same room
  socket.on('game:select', ({ roomId, square }, cb) => {
    const room = rooms.get(roomId);
    if(!room) return cb && cb({ error: 'room not found' });
    const playerId = socket.data.playerId || null;
    // remember last selected square for this socket so cards that need a target can use it
    try{ socket.data.lastSelectedSquare = square || null; }catch(e){}
    // compute legal moves for the selected square (allow capturing king)
    let moves = [];
    try{
      if(square) moves = computeLegalMoves(room, square) || [];
    }catch(e){
      console.error('computeLegalMoves error', e);
      moves = [];
    }
    // send selection to the selecting client WITH moves, but broadcast selection WITHOUT moves to other clients
    try{
      // send to selecting socket (include moves)
      socket.emit('game:select', { playerId, square, moves });
      // (pending-target flow removed) — server no longer auto-applies pending card targets on selection
      // notify other sockets in the room about the selection but without revealing the legal moves
      socket.to(roomId).emit('game:select', { playerId, square, moves: [] });
    }catch(e){
      // fallback: broadcast to all (shouldn't normally happen)
      io.to(roomId).emit('game:select', { playerId, square, moves: [] });
    }
    cb && cb({ ok: true });
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
    // enforce sender identity from socket (don't trust client-supplied playerId)
    const senderId = socket.data.playerId;
    if(!senderId) return cb && cb({ error: 'not joined' });
    // enforce one card per player per turn when the game is playing
    try{
      const board = room.boardState;
      if(room.status === 'playing' && board){
        const roomPlayer = room.players.find(p => p.id === senderId);
        const playerColorShort = (roomPlayer && roomPlayer.color && roomPlayer.color[0]) || null;
        // only allow playing a card on your turn
        if(board.turn !== playerColorShort) return cb && cb({ error: 'not your turn' });
        room._cardPlayedForVersion = room._cardPlayedForVersion || {};
        if(room._cardPlayedForVersion[senderId] === board.version) return cb && cb({ error: 'card_already_played_this_turn' });
      }
    }catch(e){ console.error('card play pre-check error', e); }
    // store played card and apply card effects when applicable
    const played = { id: uuidv4().slice(0,8), playerId: senderId, cardId, payload, ts: Date.now() };
    room.playedCards = room.playedCards || [];

    // Pre-check for targetted cards (rebondir, adoubement): require a selected target owned by the player
    try{
      const isRebond = (typeof cardId === 'string') && (cardId.indexOf('rebondir') !== -1 || cardId.indexOf('rebond') !== -1);
      const isAdoub = (typeof cardId === 'string') && (cardId.indexOf('adoub') !== -1 || cardId.indexOf('adoubement') !== -1);
      const isTargetCard = isRebond || isAdoub;
      if(isTargetCard){
        const board = room.boardState;
        let targetCandidate = payload && payload.targetSquare;
        if(!targetCandidate){ try{ targetCandidate = socket.data && socket.data.lastSelectedSquare; }catch(e){ targetCandidate = null; } }
        const roomPlayer = room.players.find(p => p.id === senderId);
        const playerColorShort = (roomPlayer && roomPlayer.color && roomPlayer.color[0]) || null;
        const targetPiece = (board && board.pieces || []).find(p => p.square === targetCandidate);
        if(!board || !targetCandidate || !targetPiece || targetPiece.color !== playerColorShort){
          // nothing should happen if there's no selected piece or the selected piece isn't owned by the player
          return cb && cb({ error: 'no valid target' });
        }
        // ensure the payload has the resolved target for downstream handling
        payload = payload || {};
        payload.targetSquare = targetCandidate;
        played.payload = Object.assign({}, payload);
      }
    }catch(e){ console.error('target card pre-check error', e); }

    // remove the played card from the player's hand and move it to discard
    try{
      room.hands = room.hands || {};
      const hand = room.hands[senderId] || [];
      // find by unique id or by cardId (first match)
      const idx = hand.findIndex(c => (c.id && c.id === (payload && payload.id)) || (c.cardId && c.cardId === cardId) || (c.id && c.id === cardId));
      if(idx === -1){
        return cb && cb({ error: 'you do not have that card' });
      }
      const removed = hand.splice(idx,1)[0];
      room.hands[senderId] = hand;
      room.discard = room.discard || [];
      room.discard.push(removed);
      // attach the removed card object to the played record for informational broadcast
      played.card = removed;
    }catch(e){
      console.error('card removal error', e);
    }

    // Implement specific card effects here
    try{
  if(cardId === 'agrandir_plateau' || cardId === 'expand_board' || (typeof cardId === 'string' && cardId.indexOf('agrandir') !== -1)){
        // Expand the board by adding one file/column on the left and right and one rank on top and bottom.
        const board = room.boardState;
        if(board && board.width && board.height){
          const oldW = board.width;
          const oldH = board.height;
          const newW = oldW + 2;
          const newH = oldH + 2;

          // helper: parse square -> coords (0-indexed)
          function squareToCoord(sq){
            if(!sq) return null;
            const s = String(sq).trim().toLowerCase();
            if(!/^[a-z][1-9][0-9]*$/.test(s)) return null;
            const file = s.charCodeAt(0) - 'a'.charCodeAt(0);
            const rank = parseInt(s.slice(1),10) - 1;
            return { x: file, y: rank };
          }
          function coordToSquare(x,y){
            return String.fromCharCode('a'.charCodeAt(0) + x) + (y+1);
          }

          // shift every piece by +1 file and +1 rank
          (board.pieces || []).forEach(p => {
            const c = squareToCoord(p.square);
            if(!c) return;
            const nx = c.x + 1;
            const ny = c.y + 1;
            p.square = coordToSquare(nx, ny);
          });

          board.width = newW;
          board.height = newH;
          board.version = (board.version || 0) + 1;

          // record effect details on payload for clients
          played.payload = Object.assign({}, payload, { applied: 'agrandir_plateau', oldWidth: oldW, oldHeight: oldH, newWidth: newW, newHeight: newH });
        }
      } else if(cardId === 'tronquer_plateau' || cardId === 'tronquer_le_plateau' || (typeof cardId === 'string' && cardId.indexOf('tronquer') !== -1)){
        // Tronquer (trim) is currently disabled: record the play but do not modify the board.
        // Historically this code computed the occupied bounding box and rewrote board.pieces/width/height.
        // That behavior caused unintended piece removals in some edge cases, so trimming is commented out for now.
        played.payload = Object.assign({}, payload, { applied: 'tronquer_plateau', note: 'disabled - trimming commented out by developer' });
      }
      // adoubement: grant a permanent knight-move ability to the targeted piece
      else if(cardId === 'adoubement' || (typeof cardId === 'string' && cardId.indexOf('adoub') !== -1)){
        try{
          const board = room.boardState;
          let target = payload && payload.targetSquare;
          if(!target){ try{ target = socket.data && socket.data.lastSelectedSquare; }catch(e){ target = null; } }
          // validate target exists and belongs to the player
          const roomPlayer = room.players.find(p => p.id === senderId);
          const playerColorShort = (roomPlayer && roomPlayer.color && roomPlayer.color[0]) || null;
          const targetPiece = (board && board.pieces || []).find(p => p.square === target);
          if(!board || !target || !targetPiece || targetPiece.color !== playerColorShort){
            // restore removed card to hand and remove from discard if necessary
            try{
              room.hands = room.hands || {};
              room.hands[senderId] = room.hands[senderId] || [];
              if(removed) room.hands[senderId].push(removed);
              room.discard = room.discard || [];
              for(let i = room.discard.length - 1; i >= 0; i--){ if(room.discard[i] && room.discard[i].id === (removed && removed.id)){ room.discard.splice(i,1); break; } }
            }catch(e){ console.error('restore removed card error', e); }
            return cb && cb({ error: 'no valid target' });
          }
          // apply permanent adoubement effect (bind to piece id so it persists when the piece moves)
          room.activeCardEffects = room.activeCardEffects || [];
          room.activeCardEffects.push({ id: played.id, type: 'adoubement', pieceId: targetPiece.id, pieceSquare: target, playerId: senderId });
          played.payload = Object.assign({}, payload, { applied: 'adoubement', appliedTo: target });
        }catch(e){ console.error('adoubement effect error', e); }
          }
          // folie: grant permanent bishop-move ability to the targeted piece
          else if(cardId === 'folie' || (typeof cardId === 'string' && cardId.indexOf('folie') !== -1)){
            try{
              const board = room.boardState;
              let target = payload && payload.targetSquare;
              if(!target){ try{ target = socket.data && socket.data.lastSelectedSquare; }catch(e){ target = null; } }
              // validate target exists and belongs to the player
              const roomPlayer = room.players.find(p => p.id === senderId);
              const playerColorShort = (roomPlayer && roomPlayer.color && roomPlayer.color[0]) || null;
              const targetPiece = (board && board.pieces || []).find(p => p.square === target);
              if(!board || !target || !targetPiece || targetPiece.color !== playerColorShort){
                // restore removed card to hand and remove from discard if necessary
                try{
                  room.hands = room.hands || {};
                  room.hands[senderId] = room.hands[senderId] || [];
                  if(removed) room.hands[senderId].push(removed);
                  room.discard = room.discard || [];
                  for(let i = room.discard.length - 1; i >= 0; i--){ if(room.discard[i] && room.discard[i].id === (removed && removed.id)){ room.discard.splice(i,1); break; } }
                }catch(e){ console.error('restore removed card error', e); }
                return cb && cb({ error: 'no valid target' });
              }
              // apply permanent folie effect (bind to piece id so it persists when the piece moves)
              room.activeCardEffects = room.activeCardEffects || [];
              room.activeCardEffects.push({ id: played.id, type: 'folie', pieceId: targetPiece.id, pieceSquare: target, playerId: senderId });
              played.payload = Object.assign({}, payload, { applied: 'folie', appliedTo: target });
            }catch(e){ console.error('folie effect error', e); }
      }
      // fortification: grant permanent rook-move ability to the targeted piece
      else if(cardId === 'fortification' || (typeof cardId === 'string' && cardId.indexOf('fortification') !== -1)){
        try{
          const board = room.boardState;
          let target = payload && payload.targetSquare;
          if(!target){ try{ target = socket.data && socket.data.lastSelectedSquare; }catch(e){ target = null; } }
          // validate target exists and belongs to the player
          const roomPlayer = room.players.find(p => p.id === senderId);
          const playerColorShort = (roomPlayer && roomPlayer.color && roomPlayer.color[0]) || null;
          const targetPiece = (board && board.pieces || []).find(p => p.square === target);
          if(!board || !target || !targetPiece || targetPiece.color !== playerColorShort){
            // restore removed card to hand and remove from discard if necessary
            try{
              room.hands = room.hands || {};
              room.hands[senderId] = room.hands[senderId] || [];
              if(removed) room.hands[senderId].push(removed);
              room.discard = room.discard || [];
              for(let i = room.discard.length - 1; i >= 0; i--){ if(room.discard[i] && room.discard[i].id === (removed && removed.id)){ room.discard.splice(i,1); break; } }
            }catch(e){ console.error('restore removed card error', e); }
            return cb && cb({ error: 'no valid target' });
          }
          // apply permanent fortification effect (bind to piece id so it persists when the piece moves)
          room.activeCardEffects = room.activeCardEffects || [];
          room.activeCardEffects.push({ id: played.id, type: 'fortification', pieceId: targetPiece.id, pieceSquare: target, playerId: senderId });
          played.payload = Object.assign({}, payload, { applied: 'fortification', appliedTo: target });
        }catch(e){ console.error('fortification effect error', e); }
      }
      // rebondir: grant a one-time bounce ability to a specific piece (targetSquare required in payload)
      else if(cardId === 'rebondir_sur_les_bords' || cardId === 'rebondir' || (typeof cardId === 'string' && cardId.indexOf('rebondir') !== -1)){
        try{
          const board = room.boardState;
          // allow the client to either provide payload.targetSquare or rely on the last selected square
          let target = payload && payload.targetSquare;
          if(!target){
            try{ target = socket.data && socket.data.lastSelectedSquare; }catch(e){ target = null; }
          }
          // validate target exists and belongs to the player; if invalid, restore card to hand and abort
          const roomPlayer = room.players.find(p => p.id === senderId);
          const playerColorShort = (roomPlayer && roomPlayer.color && roomPlayer.color[0]) || null;
          const targetPiece = (board && board.pieces || []).find(p => p.square === target);
          if(!board || !target || !targetPiece || targetPiece.color !== playerColorShort){
            // restore removed card to hand and remove from discard if necessary
            try{
              room.hands = room.hands || {};
              room.hands[senderId] = room.hands[senderId] || [];
              if(removed) room.hands[senderId].push(removed);
              room.discard = room.discard || [];
              // try to remove the removed card instance from discard (last occurrence)
              for(let i = room.discard.length - 1; i >= 0; i--){ if(room.discard[i] && room.discard[i].id === (removed && removed.id)){ room.discard.splice(i,1); break; } }
            }catch(e){ console.error('restore removed card error', e); }
            return cb && cb({ error: 'no valid target' });
          }
          // apply the rebond effect (also record pieceId so it can be identified after moves)
          room.activeCardEffects = room.activeCardEffects || [];
          room.activeCardEffects.push({ id: played.id, type: 'rebondir', pieceId: targetPiece.id, pieceSquare: target, playerId: senderId });
          played.payload = Object.assign({}, payload, { applied: 'rebondir', appliedTo: target });
        }catch(e){ console.error('rebondir effect error', e); }
      }
    }catch(e){
      console.error('card:play effect error', e);
    }

  room.playedCards.push(played);
  // mark that this player has played a card for this board version (prevents multiple cards per turn)
  try{
    const board = room.boardState;
    if(room.status === 'playing' && board){
      room._cardPlayedForVersion = room._cardPlayedForVersion || {};
      room._cardPlayedForVersion[played.playerId] = board.version;
    }
  }catch(e){ console.error('mark card played error', e); }
  // emit card played to entire room (informational)
  io.to(roomId).emit('card:played', played);
  // send personalized room updates (will include updated hands and discardCount)
  sendRoomUpdate(room);

    cb && cb({ ok: true, played });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`ChessNut server listening on port ${PORT}`);
});
