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
    autoDraw: !!room.autoDraw,
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
    // Create a per-recipient boardState view that only hides pieces targeted by an 'invisible' effect
    try{
      if(base.boardState && base.boardState.pieces && Array.isArray(base.boardState.pieces)){
        const filtered = Object.assign({}, base.boardState);
        filtered.pieces = (base.boardState.pieces || []).filter(piece => {
          try{
            // If a piece has an explicit invisible flag, hide it from recipients who are not the owner
            if(piece.invisible){
              const ownerPlayer = (room.players || []).find(pl => (pl.color && pl.color[0]) === piece.color);
              const ownerId = ownerPlayer && ownerPlayer.id;
              if(ownerId && ownerId !== p.id) return false;
            }
            // If an 'invisible' active effect targets this piece, hide it from recipients who are not the effect owner
            const inv = (room.activeCardEffects || []).find(e => e && e.type === 'invisible' && (e.pieceId === piece.id || e.pieceSquare === piece.square));
            if(inv && inv.playerId && inv.playerId !== p.id){
              return false; // hide this piece for this recipient
            }
            return true;
          }catch(_){ return true; }
        });
        payload.boardState = filtered;
      } else {
        payload.boardState = base.boardState || null;
      }
    }catch(_){ payload.boardState = base.boardState || null; }
    // attach visible squares for this recipient (fog of war)
    try{
      payload.visibleSquares = Array.from(visibleSquaresForPlayer(room, p.id) || []);
      // attach any mines owned by this recipient (mines are hidden from other players)
      try{
        const mines = (room.activeCardEffects || []).filter(e => e.type === 'mine' && e.playerId === p.id).map(e => e.square);
        payload.minesOwn = mines;
      }catch(_){ payload.minesOwn = []; }
    }catch(e){ payload.visibleSquares = []; }
    // attach captured pieces that belong to this recipient so they may choose one for resurrection
    try{
      const shortColor = (p.color && p.color[0]) || null;
      payload.capturedOwn = (room.captured || []).filter(c => c && c.piece && c.piece.color === shortColor).map(c => ({ id: c.id, type: c.piece.type, originalId: c.piece.id, originalSquare: c.piece.square, capturedBy: c.capturedBy, ts: c.ts }));
    }catch(_){ payload.capturedOwn = []; }
    if(p.socketId){
      io.to(p.socketId).emit('room:update', payload);
    }
  });
}

// Helper: at the start of a player's turn, either perform an automatic draw
// if room.autoDraw is enabled, or simply broadcast the room state so clients
// can update UI. This centralizes the auto-draw toggle behavior.
function maybeDrawAtTurnStart(room, playerId){
  try{
    if(!room) return;
    if(room.autoDraw){
      drawCardForPlayer(room, playerId);
    } else {
      // ensure clients get the updated room state even if no draw happens
      sendRoomUpdate(room);
    }
  }catch(e){ console.error('maybeDrawAtTurnStart error', e); sendRoomUpdate(room); }
}

// Compute the set of squares visible to a given player (adjacent to any of their pieces).
// Returns a Set of square strings (e.g., 'e4').
function visibleSquaresForPlayer(room, playerId){
  const out = new Set();
  if(!room || !room.boardState || !playerId) return out;
  const state = room.boardState;
  const width = state.width || 8;
  const height = state.height || 8;
  function squareToCoord(sq){
    if(!sq) return null;
    const s = String(sq).trim().toLowerCase();
    if(!/^[a-z][1-9][0-9]*$/.test(s)) return null;
    const file = s.charCodeAt(0) - 'a'.charCodeAt(0);
    const rank = parseInt(s.slice(1),10) - 1; // 0-indexed
    return { x: file, y: rank };
  }
  function coordToSquare(x,y){ if(x<0||y<0||x>=width||y>=height) return null; return String.fromCharCode('a'.charCodeAt(0) + x) + (y+1); }
  // find the player color for playerId
  const player = (room.players || []).find(p => p.id === playerId);
  if(!player) return out;
  const colorShort = (player.color && player.color[0]) || null;
  // iterate pieces belonging to player
  (state.pieces || []).forEach(piece => {
    if(piece.color !== colorShort) return;
    const c = squareToCoord(piece.square);
    if(!c) return;
    for(let dx=-1; dx<=1; dx++) for(let dy=-1; dy<=1; dy++){
      const nx = c.x + dx, ny = c.y + dy;
      const sq = coordToSquare(nx, ny);
      if(sq) out.add(sq);
    }
  });
  return out;
}

// Helper to end a player's turn after playing a card: flip turn, decrement per-turn effects and trigger next player's draw
function endTurnAfterCard(room, senderId){
  try{
    if(!room || !room.boardState) return;
    const board = room.boardState;
    // flip turn
    if(board.turn) board.turn = (board.turn === 'w') ? 'b' : 'w';
    // decrement remainingTurns for any time-limited effects that belong to the player who just finished their turn
    try{
      room.activeCardEffects = room.activeCardEffects || [];
      for(let i = room.activeCardEffects.length - 1; i >= 0; i--){
        const e = room.activeCardEffects[i];
        if(typeof e.remainingTurns === 'number'){
          let shouldDecrement = false;
          if(e.decrementOn === 'opponent'){
            shouldDecrement = (e.playerId !== senderId);
          } else if(e.decrementOn === 'owner'){
            shouldDecrement = (e.playerId === senderId);
          } else {
            shouldDecrement = (e.playerId === senderId);
          }
          if(shouldDecrement){
            e.remainingTurns = e.remainingTurns - 1;
            try{ io.to(room.id).emit('card:effect:updated', { roomId: room.id, effect: e }); }catch(_){ }
            if(e.remainingTurns <= 0){ room.activeCardEffects.splice(i,1); try{ io.to(room.id).emit('card:effect:removed', { roomId: room.id, effectId: e.id, type: e.type, playerId: e.playerId }); }catch(_){ } }
          }
        }
      }
    }catch(e){ console.error('updating temporary effects error', e); }

    // reset per-turn card-play flags
    try{ room._cardPlayedThisTurn = {}; }catch(_){ }

    // perform next player's draw (if autoDraw) or at least send room update
    try{ 
      const nextColor = board.turn;
      const nextPlayer = room.players.find(p => (p.color && p.color[0]) === nextColor);
      if(nextPlayer){ maybeDrawAtTurnStart(room, nextPlayer.id); } else { sendRoomUpdate(room); }
    }catch(_){ sendRoomUpdate(room); }
  }catch(e){ console.error('endTurnAfterCard error', e); }
}

// Build a default deck from README list. Each card has a unique id, cardId (slug), title and description.
function buildDefaultDeck(){
  const cards = [
    // ['tronquer le plateau','Tronque au maximum le plateau sans supprimer de pièce'],
    ['rebondir sur les bords','Les déplacements en diagonales de la pièce sélectionnée peuvent rebondir une fois sur les bords'],
    // ['agrandir le plateau','Rajoute une rangée dans toutes les directions'],
    ['adoubement','La pièce sélectionnée peut maintenant faire les déplacements du cavalier en plus'],
    ['folie','La pièce sélectionnée peut maintenant faire les déplacements du fou en plus'],
    ['fortification','La pièce sélectionnée peut maintenant faire les déplacements de la tour en plus'],
    ["l'anneau","Le plateau devient un anneau pendant un tour"],
    // ['brouillard de guerre','Les joueur ne peuvent voir que au alentour de leurs pièces pendant 4 tours'],
    // ['changer la pièce à capturer','Le joueur choisie la nouvelle pièce jouant le rôle de roi sans la révéler'],
    // ['trou de ver','Deux cases du plateau deviennent maintenant la même'],
    ['jouer deux fois','Le joueur peut déplacer deux pièces'],
    // ['annulation d une carte','Annule l effet d une carte qui est jouée par l adversaire'],
    ['placement de mines','Le joueur place une mine sur une case vide sans la révéler au joueur adverse. Une pièce qui se pose dessus explose et est capturée par le joueur ayant placé la mine'],
    ['vole d une pièce','Désigne une pièce non roi qui change de camp.\n\nCompte comme un mouvement'],
    ['promotion','Un pion au choix est promu'],
    ['vole d une carte','Vole une carte aléatoirement au joueur adverse'],
    ['resurection','Ressucite la dernière pièce perdue'],
    ['carte sans effet',"N'a aucun effet"],
    // ['défausse','Le joueur adverse défausse une carte de son choix'],
    // ['immunité à la capture','Désigne une pièce qui ne pourra pas être capturée au prochain tour'],
    ['kamikaz','Détruit une de ses pièces, détruisant toutes les pièces adjacentes.\n\nCompte comme un mouvement'],
    // ['retour à la case départ','Désigne une pièce qui retourne à sa position initiale'],
    // ['glissade','La pièce désignée ne peut plus s arrêter si elle se déplace en diagonale ou en ligne droite. Soit elle percute une pièce et la capture, soit elle tombe du plateau et est capturée'],
    ['invisible',"Une des pièces devient invisible pour l'adversaire"],
    // ['épidémie','Toutes les pièces sur le territoire enemie est est capturée'],
    // ['glue','Toutes les pièces autour de la pièce désignée ne peuvent pas bouger tant que cette dernière ne bouge pas'],
    ["coin coin","Possibilité de se téléporter depuis un coin vers n'importe quel autre coin"],
    ['téléportation',"Téléporte n'importe quelle pièce de son camp sur une case vide"],
    ['changement de camp','On retourne le plateau'],
    // ['ça tangue','Toutes les pièces se décale du même côté'],
    // ['réinitialisation','Toutes les pièces reviennent à leur position initiale. S il y a des pièces supplémenaires, se rangent devant les pions'],
    ["toucher c'est jouer","Toucher une pièce adverse qu'il sera obligé de jouer"],
    // ['marécage','Pendant X tours, toutes les pièces ne peuvent se déplacer que comme un roi'],
    ['sniper','Capturer une pièce sans avoir à bouger la pièce capturante'],
    ['inversion',"Échange la position d'une pièce avec une pièce adverse.\n\nCompte comme un mouvement"],
    // ['jeu des 7 différences','Déplace une pièce du plateau pendant que le joueur adverse à les yeux fermés. S il la retrouve, elle est capturée, laissée sinon'],
    // ['punching ball','Replace le roi dans sa position initiale, et place un nouveau pion à l ancienne position du roi'],
    // ['reversi','Si deux pions encadrent parfaitement une pièce adverse, cette dernière change de camp'],
    // ['plus on est de fous','Si le joueur possède deux fous dans la même diagonale, alors toutes les pièces adverses encadrées par ces deux fous sont capturés'],
    // ['cluster','Désigne 4 pions formant un rectangle. Tant que ces pions ne bougent pas, aucune pièce ne peut sortir ou rentrer dans ce rectangle.'],
    // ['vacances','Choisie une pièce qui sort du plateau pendant deux tours. Ce après quoi elle tente de revenir: si la case est occupée, alors la pièce vacancière est capturée par la pièce occupant la case.'],
    ['mélange','La position de toutes les pièces sont échangées aléatoirement'],
    ['la parrure','Une reine est dégradée en pion'],
    // ['tricherie','Choisis une carte de la pioche parmis trois'],
    ['tout ou rien','Une pièce choisie ne peut maintenant se déplacer que si elle capture.'],
    // ['tous les mêmes','Au yeux de l ennemie, toutes les pièces se ressemblent pendant 2 tours.'],
    // ['petit pion','Le joueur choisit un pion. À partir du prochain tour, il est promu en reine dès qu il capture un pièce non pion.'],
    ['révolution','Tous les pions sont aléatoirement changés en Cavalier, Fou ou Tour et les Cavaliers, Fous et Tours sont changés en pions.'],
    // ['doppelganger','Choisis une pièce. À partir de maintenant, devient chacune des pièces qu elle capture.'],
    // ['kurby','Choisis une pièce. À sa prochaine capture, récupère les mouvements de la pièce capturée.']
  ];
  function cap(s){ if(!s) return s; s = String(s).trim(); return s.charAt(0).toUpperCase() + s.slice(1); }
  return cards.map(([title,desc])=>{
    const normalized = (title||'').toString().trim();
    // generate an ASCII-friendly slug by removing diacritics before replacing non-alphanumerics
    let ascii = normalized;
    try{ ascii = ascii.normalize('NFD').replace(/\p{Diacritic}/gu, ''); }catch(e){ /* ignore if normalize unsupported */ }
    const cardId = ascii.replace(/[^a-z0-9]+/gi,'_').toLowerCase();
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
  // shuffle deck before drawing (always shuffle to ensure randomness)
  for(let i = room.deck.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = room.deck[i]; room.deck[i] = room.deck[j]; room.deck[j] = tmp;
  }
  // pick random index from the freshly shuffled deck
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
  // If this piece has been granted corner-teleport moves by 'coincoin', include those allowed squares
  try{
    const coin = (room.activeCardEffects || []).find(e => e && e.type === 'coincoin' && ((e.pieceId && e.pieceId === piece.id) || e.pieceSquare === square));
    if(coin && Array.isArray(coin.allowedSquares) && coin.allowedSquares.length > 0){
      coin.allowedSquares.forEach(sq => {
        try{
          // only add empty corner squares (do not allow capture via coincoin)
          if(!moves.some(m => m.to === sq)){
            const occ = getPieceAt(sq);
            if(!occ) moves.push({ from: square, to: sq });
          }
        }catch(_){ }
      });
    }
  }catch(_){ }
  // detect teleport effect: allow this piece to move to any empty square (one-turn temporary effect)
  try{
    const hasTeleport = (room.activeCardEffects || []).some(e => e && e.type === 'teleport' && ((e.pieceId && e.pieceId === piece.id) || e.pieceSquare === square));
    if(hasTeleport){
      // iterate all board squares and add empty ones as legal non-capturing moves
      for(let tx = 0; tx < width; tx++){
        for(let ty = 0; ty < height; ty++){
          const tsq = coordToSquare(tx, ty);
          if(!tsq) continue;
          // avoid adding the current square
          if(tsq === square) continue;
          const occ = getPieceAt(tsq);
          if(!occ && !moves.some(m => m.to === tsq)){
            moves.push({ from: square, to: tsq });
          }
        }
      }
    }
  }catch(_){ }
  // detect if this specific piece has a permanent adoubement effect (grants knight moves)
  // effects may be bound either to the piece's current square or to the piece id (preferred)
  const hasAdoubement = (room.activeCardEffects || []).some(e => e.type === 'adoubement' && ((e.pieceId && e.pieceId === piece.id) || e.pieceSquare === square));

  // helper to add knight (N) deltas when a piece has been adoubé
  function addAdoubementMoves(){
    if(!hasAdoubement) return;
    const deltas = [[1,2],[2,1],[-1,2],[-2,1],[1,-2],[2,-1],[-1,-2],[-2,-1]];
    deltas.forEach(([dx,dy])=>{
      const tx = x + dx, ty = y + dy;
      const tsq = resolveSquareWithAnneau(tx, ty);
      if(!tsq) return;
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

  // detect if the owner of this piece currently has an active 'anneau' effect
  const anneauPlayers = (room.activeCardEffects || []).filter(e => e.type === 'anneau').map(e => e.playerId);
  const ownerPlayer = (room.players || []).find(p => (p.color && p.color[0]) === piece.color);
  const hasAnneau = ownerPlayer && anneauPlayers.indexOf(ownerPlayer.id) !== -1;

  // helper to resolve a target square, allowing horizontal wrap when anneau is active for this piece
  function resolveSquareWithAnneau(tx, ty){
    // inside bounds
    if(isInside(tx, ty)) return coordToSquare(tx, ty);
    // allow only horizontal wrap (left/right) when anneau is active for this piece's owner
    if(!hasAnneau) return null;
    if(ty < 0 || ty >= height) return null; // no vertical wrapping
    if(tx < 0 || tx >= width){
      const wx = ((tx % width) + width) % width;
      return coordToSquare(wx, ty);
    }
    return null;
  }

  // filter moves according to brouillard (fog of war) if it is active for the owner of this piece
  function filterMovesByFog(moves){
    try{
      const owner = ownerPlayer;
      if(!owner) return moves;
      const hasBrouillard = (room.activeCardEffects || []).some(e => e.type === 'brouillard' && e.playerId === owner.id);
      if(!hasBrouillard) return moves;
      const vis = visibleSquaresForPlayer(room, owner.id);
      return (moves || []).filter(m => vis.has(m.to));
    }catch(e){ return moves; }
  }

  // helper to add diagonal sliding moves when a piece has been "folié"
  function addFolieMoves(){
    if(!hasFolie) return;
    const dirs = [[1,1],[1,-1],[-1,1],[-1,-1]];
    dirs.forEach(([dx,dy])=>{
      let tx = x + dx, ty = y + dy;
      let wrapped = false;
      while(true){
        // resolve target square with anneau
        let tsq = null;
        if(isInside(tx,ty)){
          tsq = coordToSquare(tx,ty);
        } else if(hasAnneau && (tx < 0 || tx >= width) && ty >= 0 && ty < height && !wrapped){
          const wx = ((tx % width) + width) % width;
          tsq = coordToSquare(wx, ty);
          tx = wx;
          wrapped = true;
        } else {
          break;
        }
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
      let wrapped = false;
      while(true){
        let tsq = null;
        if(isInside(tx,ty)){
          tsq = coordToSquare(tx,ty);
        } else if(hasAnneau && (tx < 0 || tx >= width) && ty >= 0 && ty < height && !wrapped){
          const wx = ((tx % width) + width) % width;
          tsq = coordToSquare(wx, ty);
          tx = wx;
          wrapped = true;
        } else {
          break;
        }
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
      const tsq = resolveSquareWithAnneau(tx, ty);
      if(!tsq) return;
      const occ = getPieceAt(tsq);
      if(occ && occ.color !== color) moves.push({ from: square, to: tsq });
    });
    addAdoubementMoves(); addFolieMoves(); addFortificationMoves();
    return filterMovesByFog(moves);
  }

  if(type === 'N'){
    const deltas = [[1,2],[2,1],[-1,2],[-2,1],[1,-2],[2,-1],[-1,-2],[-2,-1]];
    deltas.forEach(([dx,dy])=>{
      const tx = x + dx, ty = y + dy;
      const tsq = resolveSquareWithAnneau(tx, ty);
      if(!tsq) return;
      const occ = getPieceAt(tsq);
      if(!occ || occ.color !== color) moves.push({ from: square, to: tsq });
    });
    addAdoubementMoves(); addFolieMoves(); addFortificationMoves();
    return filterMovesByFog(moves);
  }

  if(type === 'B' || type === 'Q' || type === 'R'){
    const directions = [];
    if(type === 'B' || type === 'Q') directions.push([1,1],[1,-1],[-1,1],[-1,-1]);
    if(type === 'R' || type === 'Q') directions.push([1,0],[-1,0],[0,1],[0,-1]);

  // detect if this specific piece has an active rebondir effect (match by id or square)
  const hasRebond = (room.activeCardEffects || []).some(e => e.type === 'rebondir' && ((e.pieceId && e.pieceId === piece.id) || e.pieceSquare === square));

    directions.forEach(([dx0,dy0])=>{
      if(!hasRebond){
        // standard sliding behavior, with optional single horizontal wrap when anneau is active
        let tx = x + dx0, ty = y + dy0;
        let wrapped = false;
        while(true){
          // resolve target taking anneau into account
          let tsq = null;
          if(isInside(tx,ty)){
            tsq = coordToSquare(tx,ty);
          } else if(hasAnneau && (tx < 0 || tx >= width) && ty >= 0 && ty < height && !wrapped){
            const wx = ((tx % width) + width) % width;
            tsq = coordToSquare(wx, ty);
            // set tx to wrapped coordinate so further increments continue correctly
            tx = wx;
            wrapped = true;
          } else {
            break;
          }

          const occ = getPieceAt(tsq);
          if(!occ){
            moves.push({ from: square, to: tsq });
            // advance current position along the direction
            tx += dx0; ty += dy0;
            continue;
          }
          // occupied
          if(occ.color !== color) moves.push({ from: square, to: tsq });
          break;
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
    return filterMovesByFog(moves);
  }

  if(type === 'K'){
    for(let dx=-1; dx<=1; dx++) for(let dy=-1; dy<=1; dy++){
      if(dx === 0 && dy === 0) continue;
      const tx = x + dx, ty = y + dy;
      const tsq = resolveSquareWithAnneau(tx, ty);
      if(!tsq) continue;
      const occ = getPieceAt(tsq);
      if(!occ || occ.color !== color) moves.push({ from: square, to: tsq });
    }
    addAdoubementMoves(); addFolieMoves();
    return filterMovesByFog(moves);
  }

  addAdoubementMoves(); addFolieMoves(); addFortificationMoves();
  return filterMovesByFog(moves);
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
  rooms.set(id, { id, boardState, players: [], status: 'waiting', hostId: null, size, cards: {}, playedCards: [], removalTimers: new Map(), deck, hands: {}, autoDraw: false });
  res.json({ roomId: id, size });
});

app.get('/rooms/:id', (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: 'room not found' });
    const boardState = room.boardState || null;
    const size = (room.boardState && room.boardState.width) || room.size;
  res.json({ id: room.id, boardState, size: size, players: room.players.map(p => ({ id: p.id, color: p.color })), status: room.status, hostId: room.hostId, cards: Object.keys(room.cards || {}), autoDraw: !!room.autoDraw });
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
          if(!hasHand) maybeDrawAtTurnStart(room, assignedId);
        }
      }
    }catch(e){ console.error('post-join draw error', e); }
    cb && cb({ ok: true, color, roomId, playerId: assignedId, hostId: room.hostId });
  });

  // Host can toggle automatic drawing in the waiting room. Only the host may change this setting.
  socket.on('room:auto_draw:set', ({ roomId, enabled }, cb) => {
    const room = rooms.get(roomId);
    if(!room) return cb && cb({ error: 'room not found' });
    const sender = socket.data.playerId;
    if(!sender) return cb && cb({ error: 'not joined' });
    if(room.hostId !== sender) return cb && cb({ error: 'only the host can change auto-draw' });
    room.autoDraw = !!enabled;
    // Broadcast updated room state to all participants
    try{ sendRoomUpdate(room); }catch(_){ }
    try{ io.to(room.id).emit('room:auto_draw:changed', { roomId: room.id, enabled: room.autoDraw }); }catch(_){ }
    return cb && cb({ ok: true, autoDraw: room.autoDraw });
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

      // Enforce 'toucher' restriction: if there is an active 'toucher' effect targeting this player,
      // they may ONLY move the specified piece(s).
      try{
        const effects = room.activeCardEffects || [];
        const toucher = effects.find(e => e && e.type === 'toucher' && e.playerId === senderId);
        if(toucher && toucher.pieceId && moving.id !== toucher.pieceId){
          return cb && cb({ error: 'must_move_restricted_piece' });
        }
      }catch(_){ }

      // Enforce 'tout ou rien' restriction: if the moving piece is under 'tout_ou_rien', it may only move if the move captures
      try{
        const effects2 = room.activeCardEffects || [];
        const tout = effects2.find(e => e && e.type === 'tout_ou_rien' && e.pieceId === moving.id);
        if(tout){
          // only allow moves that capture an occupied square
          const targetIndexCheck = pieces.findIndex(p => p.square === to);
          if(targetIndexCheck === -1){
            return cb && cb({ error: 'must_capture_to_move' });
          }
        }
      }catch(_){ }

      // validate that 'to' is among legal moves
      const legal = computeLegalMoves(room, from) || [];
      const ok = legal.some(m => m.to === to);
      if(!ok) return cb && cb({ error: 'illegal move' });
      // additionally, do not allow moving into a fogged square if brouillard is active for this player
      try{
        const hasBrouillardForPlayer = (room.activeCardEffects || []).some(e => e.type === 'brouillard' && e.playerId === senderId);
        if(hasBrouillardForPlayer){
          const vis = visibleSquaresForPlayer(room, senderId);
          if(!vis.has(to)) return cb && cb({ error: 'destination not visible (fog of war)' });
        }
      }catch(e){ /* ignore */ }

      // apply move: remove any piece on target (capture)
      const targetIndex = pieces.findIndex(p => p.square === to);
      // sniper: special-case capture without moving when an active sniper effect is bound to the moving piece
      let sniperTriggered = false;
      if(targetIndex >= 0){
        // check for sniper effect bound to the moving piece for this player
        try{
          room.activeCardEffects = room.activeCardEffects || [];
          const sniperIdx = room.activeCardEffects.findIndex(e => e && e.type === 'sniper' && e.pieceId === moving.id && e.playerId === senderId);
          if(sniperIdx !== -1){
            // perform sniper capture: remove target piece and record it for potential resurrection
            const capturedPiece = pieces.splice(targetIndex, 1)[0];
            try{
              room.captured = room.captured || [];
              const originalOwner = (room.players || []).find(p => (p.color && p.color[0]) === capturedPiece.color);
              room.captured.push({ id: uuidv4().slice(0,8), piece: capturedPiece, originalOwnerId: (originalOwner && originalOwner.id) || null, capturedBy: senderId, ts: Date.now() });
              try{ if(capturedPiece && capturedPiece.invisible) delete capturedPiece.invisible; }catch(_){ }
            }catch(_){ /* ignore bookkeeping errors */ }
            // remove any invisible effects targeting the captured piece/square
            try{
              for(let ei = room.activeCardEffects.length - 1; ei >= 0; ei--){
                const ev = room.activeCardEffects[ei];
                if(!ev) continue;
                if(ev.type === 'invisible' && (ev.pieceId === capturedPiece.id || ev.pieceSquare === capturedPiece.square)){
                  try{ room.activeCardEffects.splice(ei,1); }catch(_){ }
                  try{ io.to(room.id).emit('card:effect:removed', { roomId: room.id, effectId: ev.id, type: ev.type, playerId: ev.playerId }); }catch(_){ }
                }
              }
            }catch(_){ }
            // consume the sniper effect (one-time)
            try{
              const removedEffect = room.activeCardEffects.splice(sniperIdx, 1)[0];
              try{ io.to(room.id).emit('card:effect:removed', { roomId: room.id, effectId: removedEffect && removedEffect.id, type: 'sniper', playerId: removedEffect && removedEffect.playerId }); }catch(_){ }
            }catch(_){ }
            sniperTriggered = true;
          } else {
            // no sniper: normal capture
            const capturedPiece = pieces.splice(targetIndex, 1)[0];
            try{
              room.captured = room.captured || [];
              const originalOwner = (room.players || []).find(p => (p.color && p.color[0]) === capturedPiece.color);
              room.captured.push({ id: uuidv4().slice(0,8), piece: capturedPiece, originalOwnerId: (originalOwner && originalOwner.id) || null, capturedBy: senderId, ts: Date.now() });
              try{ if(capturedPiece && capturedPiece.invisible) delete capturedPiece.invisible; }catch(_){ }
            }catch(_){ /* ignore bookkeeping errors */ }
            // If there were any 'invisible' effects targeting the captured piece or its square,
            // remove them so the square does not remain hidden for non-owners when another piece arrives.
            try{
              for(let ei = room.activeCardEffects.length - 1; ei >= 0; ei--){
                const ev = room.activeCardEffects[ei];
                if(!ev) continue;
                if(ev.type === 'invisible' && (ev.pieceId === capturedPiece.id || ev.pieceSquare === capturedPiece.square)){
                  try{ room.activeCardEffects.splice(ei,1); }catch(_){ }
                  try{ io.to(room.id).emit('card:effect:removed', { roomId: room.id, effectId: ev.id, type: ev.type, playerId: ev.playerId }); }catch(_){ }
                }
              }
            }catch(_){ }
          }
        }catch(_){
          // fallback: perform normal capture
          const capturedPiece = pieces.splice(targetIndex, 1)[0];
          try{ room.captured = room.captured || []; const originalOwner = (room.players || []).find(p => (p.color && p.color[0]) === capturedPiece.color); room.captured.push({ id: uuidv4().slice(0,8), piece: capturedPiece, originalOwnerId: (originalOwner && originalOwner.id) || null, capturedBy: senderId, ts: Date.now() }); }catch(_){ }
        }
      }
      // move the piece only if sniper didn't trigger
      if(!sniperTriggered){ moving.square = to; }

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

      // Check for hidden mines at the destination square. If a mine belonging to another player
      // is present, detonate it: remove the moving piece and consume the mine. The mine location
      // is kept private (only the owner sees it in their `minesOwn`), but detonations are public.
      try{
        room.activeCardEffects = room.activeCardEffects || [];
        for(let i = room.activeCardEffects.length - 1; i >= 0; i--){
          const e = room.activeCardEffects[i];
          if(e && e.type === 'mine' && e.square === to){
            // detonate for any piece that lands on the mine (owner included)
            // remove the moving piece from the board and record it as captured by the mine owner
            const rmIdx = pieces.findIndex(p => p.id === moving.id);
            if(rmIdx >= 0){
              const capturedPiece = pieces.splice(rmIdx, 1)[0];
              try{
                room.captured = room.captured || [];
                const originalOwner = (room.players || []).find(p => (p.color && p.color[0]) === capturedPiece.color);
                room.captured.push({ id: uuidv4().slice(0,8), piece: capturedPiece, originalOwnerId: (originalOwner && originalOwner.id) || null, capturedBy: e.playerId, ts: Date.now() });
              }catch(_){ }
            }
            // consume the mine
            try{ room.activeCardEffects.splice(i,1); }catch(_){ }
            // broadcast detonation to the room (informational)
            try{ io.to(roomId).emit('mine:detonated', { roomId: room.id, ownerId: e.playerId, detonatorId: senderId, square: to, piece: moving }); }catch(_){ }
            // privately inform the owner as well with effect id and piece details
            try{ const owner = (room.players||[]).find(p => p.id === e.playerId); if(owner && owner.socketId) io.to(owner.socketId).emit('mine:detonated:private', { roomId: room.id, effectId: e.id, square: to, piece: moving }); }catch(_){ }
            // a mine was found/handled; break (only one mine per square expected)
            break;
          }
        }
      }catch(err){ console.error('mine detonation error', err); }

      // advance board version
      board.version = (board.version || 0) + 1;

      // If the player was granted a free move by playing a card just now (room._freeMoveFor), consume it
      // and mark that we should end the turn after this move. We DO NOT treat it like a 'double_move' —
      // instead it is the player's one move for the turn and should cause normal end-of-turn bookkeeping.
      let consumedDoubleMove = false;
      let freeMoveConsumed = false;
      try{
        if(room && room._freeMoveFor && room._freeMoveFor === senderId){
          // consume the free-move token and remember to end the turn after this move
          freeMoveConsumed = true;
          try{ delete room._freeMoveFor; }catch(_){ room._freeMoveFor = null; }
          try{ io.to(room.id).emit('card:free_move_consumed', { roomId: room.id, playerId: senderId }); }catch(_){ }
        }
      }catch(e){ /* ignore */ }

      // Attempt to consume a double-move effect for the moving player. If present, this allows the player
      // to make an additional move without flipping the turn. We represent that effect as:
      // { type: 'double_move', playerId, remainingMoves }
      try{
        room.activeCardEffects = room.activeCardEffects || [];
        for(let i = room.activeCardEffects.length - 1; i >= 0; i--){
          const e = room.activeCardEffects[i];
          if(e.type === 'double_move' && e.playerId === senderId){
            // compute remaining moves after consuming one
            const newRemaining = (typeof e.remainingMoves === 'number') ? (e.remainingMoves - 1) : ((e.remainingMoves || 2) - 1);
            // update or remove depending on remaining count
            if(newRemaining > 0){
              e.remainingMoves = newRemaining;
              consumedDoubleMove = true; // still have extra moves, so don't flip the turn
              try{ io.to(room.id).emit('card:effect:updated', { roomId: room.id, effect: e }); }catch(_){ }
            } else {
              // used up: remove the effect and emit removal
              try{
                room.activeCardEffects.splice(i,1);
              }catch(_){ }
              try{ io.to(room.id).emit('card:effect:removed', { roomId: room.id, effectId: e.id, type: e.type, playerId: e.playerId }); }catch(_){ }
            }
            break;
          }
        }
      }catch(err){ console.error('double_move consume error', err); }

      // If the player didn't consume a double-move effect, flip turn and decrement per-turn effects
      if(!consumedDoubleMove){
        board.turn = (board.turn === 'w') ? 'b' : 'w';

        // decrement remainingTurns for any time-limited effects that belong to the player who just finished their turn
        try{
          room.activeCardEffects = room.activeCardEffects || [];
          for(let i = room.activeCardEffects.length - 1; i >= 0; i--){
            const e = room.activeCardEffects[i];
            if(typeof e.remainingTurns === 'number'){
              // determine whether this effect should be decremented when the player who just finished their turn is `senderId`.
              let shouldDecrement = false;
              if(e.decrementOn === 'opponent'){
                // decrement when the finished-turn player is NOT the effect owner
                shouldDecrement = (e.playerId !== senderId);
              } else if(e.decrementOn === 'owner'){
                // decrement only when the finished-turn player is the effect owner (legacy/default behavior)
                shouldDecrement = (e.playerId === senderId);
              } else {
                // default: existing semantics (decrement on the owner's turn)
                shouldDecrement = (e.playerId === senderId);
              }
              if(shouldDecrement){
                e.remainingTurns = e.remainingTurns - 1;
                // emit informative event when effect is decremented/removed
                try{ io.to(room.id).emit('card:effect:updated', { roomId: room.id, effect: e }); }catch(_){ }
                if(e.remainingTurns <= 0){
                  // remove expired effect
                  room.activeCardEffects.splice(i,1);
                  try{ io.to(room.id).emit('card:effect:removed', { roomId: room.id, effectId: e.id, type: e.type, playerId: e.playerId }); }catch(_){ }
                }
              }
            }
          }
        }catch(e){ console.error('updating temporary effects error', e); }

        // reset per-turn card-play flags because turn changed
        try{ room._cardPlayedThisTurn = {}; }catch(_){}
      }

      // at this point the board has been updated (and possibly the turn flipped)
      // determine next player and perform their draw BEFORE broadcasting the move, so the draw happens at the start of their turn
  const moved = { playerId: senderId, from, to };
      try{
          if(!consumedDoubleMove){
          const nextColor = board.turn; // 'w' or 'b'
          const nextPlayer = room.players.find(p => (p.color && p.color[0]) === nextColor);
          if(nextPlayer){
            // draw for next player (respect room.autoDraw)
            maybeDrawAtTurnStart(room, nextPlayer.id);
          } else {
            // ensure room state is broadcast
            sendRoomUpdate(room);
          }
        } else {
          // the same player still has an extra move; do not draw a new card now — just broadcast the updated room state
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
  // Do not broadcast the raw boardState to all sockets (use per-recipient sendRoomUpdate to enforce invisibility)
  io.to(roomId).emit('game:started', { roomId });
  sendRoomUpdate(room);

    // draw initial card for the player to move (beginning of their turn)
    // If the player already has a card (for instance the special starter card), skip the automatic draw
    try{
      if(room.boardState && room.boardState.turn){
        const firstColor = room.boardState.turn; // 'w' or 'b'
        const firstPlayer = room.players.find(p => (p.color && p.color[0]) === firstColor);
        if(firstPlayer){
          const hasHand = room.hands && room.hands[firstPlayer.id] && room.hands[firstPlayer.id].length > 0;
          if(!hasHand) maybeDrawAtTurnStart(room, firstPlayer.id);
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
    // Enforce 'toucher' restriction: if the selecting player is affected by a 'toucher' effect,
    // they may only move the targeted piece. If they select another piece, show no moves.
    try{
      const effects = room.activeCardEffects || [];
      const toucherEffects = effects.filter(e => e && e.type === 'toucher' && e.playerId === playerId);
      if(toucherEffects && toucherEffects.length > 0){
        const selectedPiece = (room.boardState && room.boardState.pieces || []).find(p => p.square === square);
        const allowedPieceIds = toucherEffects.map(e => e.pieceId).filter(Boolean);
        if(!selectedPiece || allowedPieceIds.indexOf(selectedPiece.id) === -1){
          moves = [];
        }
      }
    }catch(_){ /* ignore enforcement errors */ }
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

  // Manual draw by player (consumes the player's turn). Only valid when autoDraw is disabled.
  socket.on('player:draw', ({ roomId }, cb) => {
    const room = rooms.get(roomId);
    if(!room) return cb && cb({ error: 'room not found' });
    const senderId = socket.data.playerId;
    if(!senderId) return cb && cb({ error: 'not joined' });
    const board = room.boardState;
    if(!board) return cb && cb({ error: 'no board state' });
    const roomPlayer = room.players.find(p => p.id === senderId);
    if(!roomPlayer) return cb && cb({ error: 'player not in room' });
    const playerColorShort = (roomPlayer.color && roomPlayer.color[0]) || null;
    // must be player's turn
    if(board.turn !== playerColorShort) return cb && cb({ error: 'not your turn' });
    // manual draw only allowed when autoDraw is disabled
    if(room.autoDraw) return cb && cb({ error: 'auto_draw_enabled' });
    // do not allow drawing if player already played a card this turn
    room._cardPlayedThisTurn = room._cardPlayedThisTurn || {};
    if(room._cardPlayedThisTurn[senderId]) return cb && cb({ error: 'card_already_played_this_turn' });

    try{
      // perform the draw (this will emit card:drawn privately and send personalized room:update)
      const drawn = drawCardForPlayer(room, senderId);
      if(!drawn){
        // nothing drawn (hand full or deck empty)
        return cb && cb({ error: 'no_card_drawn' });
      }
      // drawing consumes the player's turn: flip turn and decrement per-turn effects
      // advance board version
      board.version = (board.version || 0) + 1;

      // If the move consumed a free-move granted by a card, perform end-of-turn bookkeeping now
      if(freeMoveConsumed){
        const moved = { playerId: senderId, from, to };
        try{ io.to(roomId).emit('move:moved', moved); }catch(_){ }
        try{ endTurnAfterCard(room, senderId); }catch(e){ try{ sendRoomUpdate(room); }catch(_){ } }
        return cb && cb({ ok: true, moved });
      }
      // flip turn
      board.turn = (board.turn === 'w') ? 'b' : 'w';
      // decrement remainingTurns for time-limited effects that belong to the player who just finished their turn
      try{
        room.activeCardEffects = room.activeCardEffects || [];
        for(let i = room.activeCardEffects.length - 1; i >= 0; i--){
          const e = room.activeCardEffects[i];
          if(typeof e.remainingTurns === 'number'){
            let shouldDecrement = false;
            if(e.decrementOn === 'opponent'){
              shouldDecrement = (e.playerId !== senderId);
            } else if(e.decrementOn === 'owner'){
              shouldDecrement = (e.playerId === senderId);
            } else {
              shouldDecrement = (e.playerId === senderId);
            }
            if(shouldDecrement){
              e.remainingTurns = e.remainingTurns - 1;
              try{ io.to(room.id).emit('card:effect:updated', { roomId: room.id, effect: e }); }catch(_){ }
              if(e.remainingTurns <= 0){ room.activeCardEffects.splice(i,1); try{ io.to(room.id).emit('card:effect:removed', { roomId: room.id, effectId: e.id, type: e.type, playerId: e.playerId }); }catch(_){ } }
            }
          }
        }
      }catch(e){ console.error('decrement-after-draw error', e); }

      // reset per-turn card-play flags
      try{ room._cardPlayedThisTurn = {}; }catch(_){ }

      // at this point it's the next player's turn; perform start-of-turn draw if autoDraw enabled
      const nextColor = board.turn;
      const nextPlayer = (room.players || []).find(p => (p.color && p.color[0]) === nextColor);
      if(nextPlayer){ try{ maybeDrawAtTurnStart(room, nextPlayer.id); }catch(_){ sendRoomUpdate(room); } }
      else { sendRoomUpdate(room); }

      // notify room that the player drew and ended their turn
      try{ io.to(room.id).emit('player:drew', { roomId: room.id, playerId: senderId, card: drawn }); }catch(_){ }
      return cb && cb({ ok: true, card: drawn });
    }catch(err){ console.error('player:draw error', err); return cb && cb({ error: 'server_error' }); }
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
        // track card plays per turn (not per board version) so effects like "double move" don't allow extra card plays
        room._cardPlayedThisTurn = room._cardPlayedThisTurn || {};
        if(room._cardPlayedThisTurn[senderId]) return cb && cb({ error: 'card_already_played_this_turn' });
      }
    }catch(e){ console.error('card play pre-check error', e); }
    // store played card and apply card effects when applicable
    const played = { id: uuidv4().slice(0,8), playerId: senderId, cardId, payload, ts: Date.now() };
    room.playedCards = room.playedCards || [];

    // Pre-check for targetted cards (rebondir, adoubement, folie, fortification): require a selected target owned by the player
    try{
      const isRebond = (typeof cardId === 'string') && (cardId.indexOf('rebondir') !== -1 || cardId.indexOf('rebond') !== -1);
      const isAdoub = (typeof cardId === 'string') && (cardId.indexOf('adoub') !== -1 || cardId.indexOf('adoubement') !== -1);
      const isFolie = (typeof cardId === 'string') && (cardId.indexOf('folie') !== -1 || cardId.indexOf('fou') !== -1);
      const isFort = (typeof cardId === 'string') && (cardId.indexOf('fortification') !== -1 || cardId.indexOf('fortif') !== -1);
      const isTargetCard = isRebond || isAdoub || isFolie || isFort;
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
  // normalize cardId to the card's slug when the client passed an instance id
  cardId = (removed && removed.cardId) || cardId;
    }catch(e){
      console.error('card removal error', e);
    }

  // Implement specific card effects here
  // Convention: For cards that require a target, if the target is invalid the card is consumed by default
  // (player loses the card). If you want a different behavior for a specific card, explicitly restore
  // the removed card to the player's hand in that branch. This keeps UX consistent across cards.
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
      // toucher c'est jouer: force the targeted player to move only the chosen piece on their next turn
      else if((typeof cardId === 'string' && cardId.indexOf('toucher') !== -1) || cardId === 'toucher_cest_jouer'){
        try{
          const board = room.boardState;
          let target = payload && payload.targetSquare;
          if(!target){ try{ target = socket.data && socket.data.lastSelectedSquare; }catch(e){ target = null; } }
          const roomPlayer = room.players.find(p => p.id === senderId);
          const playerColorShort = (roomPlayer && roomPlayer.color && roomPlayer.color[0]) || null;
          const targetPiece = (board && board.pieces || []).find(p => p.square === target);
          // validate target exists and belongs to the opponent
          if(!board || !target || !targetPiece || targetPiece.color === playerColorShort){
            // invalid target: restore removed card to hand and abort
            try{
              room.hands = room.hands || {};
              room.hands[senderId] = room.hands[senderId] || [];
              if(removed) room.hands[senderId].push(removed);
              room.discard = room.discard || [];
              for(let i = room.discard.length - 1; i >= 0; i--){ if(room.discard[i] && room.discard[i].id === (removed && removed.id)){ room.discard.splice(i,1); break; } }
            }catch(e){ console.error('restore removed card error', e); }
            return cb && cb({ error: 'no valid target' });
          }
          // find the owner (player) of the targeted piece
          const targetOwner = (room.players || []).find(p => (p.color && p.color[0]) === targetPiece.color) || null;
          // create a one-turn effect that forces the targetOwner to move only this piece on their next turn
          room.activeCardEffects = room.activeCardEffects || [];
          const effect = { id: played.id, type: 'toucher', playerId: (targetOwner && targetOwner.id) || null, pieceId: targetPiece.id, pieceSquare: targetPiece.square, remainingTurns: 1, decrementOn: 'owner', imposedBy: senderId, ts: Date.now() };
          room.activeCardEffects.push(effect);
          played.payload = Object.assign({}, payload, { applied: 'toucher', appliedTo: target });
          try{ io.to(room.id).emit('card:effect:applied', { roomId: room.id, effect }); }catch(_){ }
        }catch(e){ console.error('toucher effect error', e); }
        }
        // la parrure: downgrade an enemy queen to a pawn (selected target must be an enemy queen)
        else if((typeof cardId === 'string' && cardId.indexOf('parrure') !== -1) || cardId === 'la_parrure'){
          try{
            const board = room.boardState;
            let target = payload && payload.targetSquare;
            if(!target){ try{ target = socket.data && socket.data.lastSelectedSquare; }catch(e){ target = null; } }
            const roomPlayer = room.players.find(p => p.id === senderId);
            const playerColorShort = (roomPlayer && roomPlayer.color && roomPlayer.color[0]) || null;
            const targetPiece = (board && board.pieces || []).find(p => p.square === target);
            // validate target exists and belongs to the opponent and is a queen
            if(!board || !target || !targetPiece || targetPiece.color === playerColorShort || !targetPiece.type || targetPiece.type.toLowerCase() !== 'q'){
              // invalid target: do NOT restore the removed card (card is consumed). Return error but card remains in discard.
              return cb && cb({ error: 'no valid target' });
            }
            // perform downgrade: change piece type to pawn
            try{
              targetPiece.type = 'p';
              if(targetPiece.promoted) delete targetPiece.promoted;
              // bump board version so clients react to the board mutation
              try{ board.version = (board.version || 0) + 1; }catch(_){ }
              played.payload = Object.assign({}, payload, { applied: 'parrure', appliedTo: target });
              try{ io.to(room.id).emit('card:effect:applied', { roomId: room.id, effect: { id: played.id, type: 'parrure', pieceId: targetPiece.id, pieceSquare: targetPiece.square, playerId: senderId } }); }catch(_){ }
            }catch(e){ console.error('parrure apply error', e); }
          }catch(e){ console.error('parrure effect error', e); }
        }
        // sniper: bind a one-time sniper effect to one of your pieces.
        // After playing this card the owner selects one of their pieces; the effect is recorded and
        // when that piece later makes a capturing move, the capture is performed without moving the capturer.
        else if((typeof cardId === 'string' && cardId.indexOf('sniper') !== -1) || cardId === 'sniper'){
          try{
            const board = room.boardState;
            // client may send selected piece in payload.targetSquare (legacy owned selection) or payload.sourceSquare
            let source = (payload && payload.sourceSquare) || (payload && payload.targetSquare) || null;
            if(!source){ try{ source = socket.data && socket.data.lastSelectedSquare; }catch(e){ source = null; } }
            const roomPlayer = room.players.find(p => p.id === senderId);
            const playerColorShort = (roomPlayer && roomPlayer.color && roomPlayer.color[0]) || null;
            const srcPiece = (board && board.pieces || []).find(p => p.square === source);
            if(!board || !source || !srcPiece || srcPiece.color !== playerColorShort){
              // invalid target: restore card to hand and abort
              try{
                room.hands = room.hands || {};
                room.hands[senderId] = room.hands[senderId] || [];
                if(removed) room.hands[senderId].push(removed);
                room.discard = room.discard || [];
                for(let i = room.discard.length - 1; i >= 0; i--){ if(room.discard[i] && room.discard[i].id === (removed && removed.id)){ room.discard.splice(i,1); break; } }
              }catch(_){ }
              return cb && cb({ error: 'no valid source selected' });
            }
            // bind sniper effect to the piece id (one-time use)
            room.activeCardEffects = room.activeCardEffects || [];
            const effect = { id: played.id, type: 'sniper', playerId: senderId, pieceId: srcPiece.id, pieceSquare: srcPiece.square, remainingUses: 1, imposedBy: senderId, ts: Date.now() };
            room.activeCardEffects.push(effect);
            played.payload = Object.assign({}, payload, { applied: 'sniper_bound', appliedTo: source });
            try{ io.to(room.id).emit('card:effect:applied', { roomId: room.id, effect }); }catch(_){ }
          }catch(e){ console.error('sniper binding error', e); }
        }
        // tout ou rien: choose a piece; that piece may only move if it captures (one owner turn)
        else if((typeof cardId === 'string' && cardId.indexOf('tout') !== -1 && cardId.indexOf('rien') !== -1) || cardId === 'tout_ou_rien'){
          try{
            const board = room.boardState;
            let target = payload && payload.targetSquare;
            if(!target){ try{ target = socket.data && socket.data.lastSelectedSquare; }catch(e){ target = null; } }
            const targetPiece = (board && board.pieces || []).find(p => p.square === target);
            if(!board || !target || !targetPiece){
              // invalid target: do not restore card (consume) and return error
              return cb && cb({ error: 'no valid target' });
            }
            // do not allow kings to be affected
            if(targetPiece.type && targetPiece.type.toLowerCase() === 'k'){
              // consume card but report invalid
              return cb && cb({ error: 'cannot_target_king' });
            }
            // find owner of the targeted piece
            const targetOwner = (room.players || []).find(p => (p.color && p.color[0]) === targetPiece.color) || null;
            room.activeCardEffects = room.activeCardEffects || [];
            // Make 'tout_ou_rien' permanent until explicitly removed by another effect
            const effect = { id: played.id, type: 'tout_ou_rien', playerId: (targetOwner && targetOwner.id) || null, pieceId: targetPiece.id, pieceSquare: targetPiece.square, imposedBy: senderId, ts: Date.now() };
            room.activeCardEffects.push(effect);
            played.payload = Object.assign({}, payload, { applied: 'tout_ou_rien', appliedTo: target });
            try{ io.to(room.id).emit('card:effect:applied', { roomId: room.id, effect }); }catch(_){ }
          }catch(e){ console.error('tout_ou_rien effect error', e); }
        }
        // inversion: pick one of your pieces, then pick an enemy piece — swap their squares
        else if((typeof cardId === 'string' && cardId.indexOf('inversion') !== -1) || cardId === 'inversion'){
          try{
            const board = room.boardState;
            const payloadSrc = payload && payload.sourceSquare;
            const payloadTgt = payload && payload.targetSquare;
            // fallback to lastSelectedSquare for source if client didn't provide both
            let source = payloadSrc || null;
            let target = payloadTgt || null;
            if(!source){ try{ source = socket.data && socket.data.lastSelectedSquare; }catch(_){ source = null; } }
            if(!target){ /* nothing */ }
            const roomPlayer = room.players.find(p => p.id === senderId);
            const playerColorShort = (roomPlayer && roomPlayer.color && roomPlayer.color[0]) || null;
            const srcPiece = (board && board.pieces || []).find(p => p.square === source);
            const tgtPiece = (board && board.pieces || []).find(p => p.square === target);
            // validate both pieces exist and belong respectively to player and opponent
            if(!board || !source || !target || !srcPiece || !tgtPiece || srcPiece.color !== playerColorShort || tgtPiece.color === playerColorShort){
              // invalid target(s): restore removed card to hand and abort
              try{ room.hands = room.hands || {}; room.hands[senderId] = room.hands[senderId] || []; if(removed) room.hands[senderId].push(removed); room.discard = room.discard || []; for(let i = room.discard.length - 1; i >= 0; i--){ if(room.discard[i] && room.discard[i].id === (removed && removed.id)){ room.discard.splice(i,1); break; } } }catch(e){ console.error('restore removed card error', e); }
              return cb && cb({ error: 'no valid targets' });
            }
            // swap their squares
            try{
              const sSquare = srcPiece.square;
              const tSquare = tgtPiece.square;
              srcPiece.square = tSquare;
              tgtPiece.square = sSquare;
              // update any activeCardEffects that reference squares
              try{
                room.activeCardEffects = room.activeCardEffects || [];
                room.activeCardEffects.forEach(e => {
                  try{
                    if(e && e.pieceSquare && e.pieceSquare === sSquare) e.pieceSquare = tSquare;
                    else if(e && e.pieceSquare && e.pieceSquare === tSquare) e.pieceSquare = sSquare;
                  }catch(_){ }
                });
              }catch(_){ }
              // bump board version
              try{ board.version = (board.version || 0) + 1; }catch(_){ }
              played.payload = Object.assign({}, payload, { applied: 'inversion', from: source, to: target });
              try{ io.to(room.id).emit('card:effect:applied', { roomId: room.id, effect: { id: played.id, type: 'inversion', swapped: [srcPiece.id, tgtPiece.id], playerId: senderId } }); }catch(_){ }
            }catch(e){ console.error('inversion apply error', e); }
          }catch(e){ console.error('inversion effect error', e); }
      }
      // teleportation: allow the selected piece to move to any empty square for one turn
      else if((typeof cardId === 'string' && (cardId.indexOf('teleport') !== -1 || cardId.indexOf('t_l_portation') !== -1 || cardId.indexOf('t_lportation') !== -1)) || cardId === 'teleport'){
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
          // apply a temporary teleport effect bound to the piece id for one owner turn
          room.activeCardEffects = room.activeCardEffects || [];
          const effect = { id: played.id, type: 'teleport', pieceId: targetPiece.id, pieceSquare: target, playerId: senderId, remainingTurns: 1, decrementOn: 'owner' };
          room.activeCardEffects.push(effect);
          played.payload = Object.assign({}, payload, { applied: 'teleport', appliedTo: target });
          try{ io.to(room.id).emit('card:effect:applied', { roomId: room.id, effect }); }catch(_){ }
        }catch(e){ console.error('teleport effect error', e); }
        }
      // changement de camp / flip sides: swap the camps so each player controls the other's pieces
      else if((typeof cardId === 'string' && (cardId.indexOf('changement') !== -1 || cardId.indexOf('changer') !== -1 || cardId.indexOf('change') !== -1 || cardId.indexOf('camp') !== -1)) || cardId === 'changement_de_camp'){
        try{
          const board = room.boardState;
          if(!board || !Array.isArray(board.pieces)){
            // nothing to do; restore card
            try{
              room.hands = room.hands || {};
              room.hands[senderId] = room.hands[senderId] || [];
              if(removed) room.hands[senderId].push(removed);
              room.discard = room.discard || [];
              for(let i = room.discard.length - 1; i >= 0; i--){ if(room.discard[i] && room.discard[i].id === (removed && removed.id)){ room.discard.splice(i,1); break; } }
            }catch(e){ }
            return cb && cb({ error: 'no board to flip' });
          }
          // swap piece colors
          // helper: square <-> coords
          function squareToCoord(sq){ if(!sq) return null; const s = String(sq).trim().toLowerCase(); if(!/^[a-z][1-9][0-9]*$/.test(s)) return null; const file = s.charCodeAt(0) - 'a'.charCodeAt(0); const rank = parseInt(s.slice(1),10) - 1; return { x: file, y: rank }; }
          function coordToSquare(x,y){ if(x<0||y<0||!board.width||!board.height) return null; if(x<0||y<0||x>=board.width||y>=board.height) return null; return String.fromCharCode('a'.charCodeAt(0) + x) + (y+1); }
          // perform 180° rotation and swap piece colors
          const w = board.width || 8; const h = board.height || 8;
          (board.pieces || []).forEach(p => {
            try{
              // rotate square
              const c = squareToCoord(p.square);
              if(c){ const nx = (w - 1) - c.x; const ny = (h - 1) - c.y; const ns = coordToSquare(nx, ny); if(ns) p.square = ns; }
              // swap colour
              p.color = (p.color === 'w' ? 'b' : (p.color === 'b' ? 'w' : p.color));
            }catch(_){ }
          });
          // also rotate/adjust any active effect squares (pieceSquare, square, allowedSquares)
          try{
            room.activeCardEffects = room.activeCardEffects || [];
            room.activeCardEffects.forEach(e => {
              if(!e) return;
              try{
                if(e.pieceSquare){ const c = squareToCoord(e.pieceSquare); if(c){ const nx = (w-1)-c.x; const ny = (h-1)-c.y; const ns = coordToSquare(nx,ny); if(ns) e.pieceSquare = ns; } }
                if(e.square){ const c2 = squareToCoord(e.square); if(c2){ const nx = (w-1)-c2.x; const ny = (h-1)-c2.y; const ns2 = coordToSquare(nx,ny); if(ns2) e.square = ns2; } }
                if(Array.isArray(e.allowedSquares)){
                  e.allowedSquares = e.allowedSquares.map(sq => { const cc = squareToCoord(sq); if(!cc) return sq; const nx = (w-1)-cc.x; const ny = (h-1)-cc.y; return coordToSquare(nx,ny) || sq; });
                }
              }catch(_){ }
            });
          }catch(_){ }
          // swap players' assigned colors (so UIs re-orient)
          (room.players || []).forEach(pl => { try{ pl.color = (pl.color === 'white' ? 'black' : (pl.color === 'black' ? 'white' : pl.color)); }catch(_){ } });
          // flip whose turn it is (since colors swapped)
          if(board.turn) board.turn = (board.turn === 'w' ? 'b' : (board.turn === 'b' ? 'w' : board.turn));
          // bump board version
          board.version = (board.version || 0) + 1;
          // emit an effect to notify clients
          const effect = { id: played.id, type: 'changement_de_camp', playerId: senderId, ts: Date.now() };
          room.activeCardEffects = room.activeCardEffects || [];
          room.activeCardEffects.push(effect);
          played.payload = Object.assign({}, payload, { applied: 'changement_de_camp' });
          try{ io.to(room.id).emit('card:effect:applied', { roomId: room.id, effect }); }catch(_){ }
        }catch(e){ console.error('changement de camp error', e); }
      }
        // promotion: promote one of your pawns to a queen
        else if(cardId === 'promotion' || cardId === 'promote' || (typeof cardId === 'string' && (cardId.indexOf('promotion') !== -1 || cardId.indexOf('promot') !== -1 || cardId.indexOf('promouvoir') !== -1))){
          try{
            const board = room.boardState;
            let target = payload && payload.targetSquare;
            if(!target){ try{ target = socket.data && socket.data.lastSelectedSquare; }catch(e){ target = null; } }
            const roomPlayer = room.players.find(p => p.id === senderId);
            const playerColorShort = (roomPlayer && roomPlayer.color && roomPlayer.color[0]) || null;
            const targetPiece = (board && board.pieces || []).find(p => p.square === target);
            // validate target exists and belongs to the player and is a pawn
            if(!board || !target || !targetPiece || targetPiece.color !== playerColorShort || (targetPiece.type && String(targetPiece.type).toLowerCase() !== 'p')){
              // Invalid target: consume the card and notify owner (promotion failed)
              played.payload = Object.assign({}, payload, { applied: 'promotion_failed', attemptedTo: target });
              try{ const owner = (room.players || []).find(p => p.id === senderId); if(owner && owner.socketId) io.to(owner.socketId).emit('card:effect:applied', { roomId: room.id, effect: { id: played.id, type: 'promotion_failed', playerId: senderId, square: target, ts: Date.now() } }); }catch(_){ }
            } else {
              // mutate the piece: promote to chosen piece (default to queen)
              const oldType = targetPiece.type;
              const chosen = (payload && (payload.promotion || payload.targetPromotion || payload.promoteTo)) || 'q';
              const mapping = { q: 'q', r: 'r', b: 'b', n: 'n' };
              const toType = mapping[String(chosen).toLowerCase()] || 'q';
              targetPiece.type = toType;
              // optional flag to indicate promotion
              targetPiece.promoted = true;
              // emit applied effect for clients to show special UI if desired
              try{
                const effect = { id: played.id, type: 'promotion', pieceId: targetPiece.id, pieceSquare: target, playerId: senderId, ts: Date.now() };
                room.activeCardEffects = room.activeCardEffects || [];
                room.activeCardEffects.push(effect);
                try{ io.to(room.id).emit('card:effect:applied', { roomId: room.id, effect }); }catch(_){ }
              }catch(_){ }
              played.payload = Object.assign({}, payload, { applied: 'promotion', appliedTo: target, fromType: oldType, toType: targetPiece.type });
            }
          }catch(e){ console.error('promotion effect error', e); }
        }
        // kamikaz: destroy one of your pieces and all adjacent pieces
        else if(cardId === 'kamikaz' || (typeof cardId === 'string' && cardId.indexOf('kamikaz') !== -1)){
          try{
            const board = room.boardState;
            // determine target square from payload or last selected
            let target = payload && payload.targetSquare;
            if(!target){ try{ target = socket.data && socket.data.lastSelectedSquare; }catch(e){ target = null; } }
            const roomPlayer = room.players.find(p => p.id === senderId);
            const playerColorShort = (roomPlayer && roomPlayer.color && roomPlayer.color[0]) || null;
            const targetPiece = (board && board.pieces || []).find(p => p.square === target);
            // validate target exists and belongs to the player
            if(!board || !target || !targetPiece || targetPiece.color !== playerColorShort){
              // restore removed card to hand and abort
              try{
                room.hands = room.hands || {};
                room.hands[senderId] = room.hands[senderId] || [];
                if(removed) room.hands[senderId].push(removed);
                room.discard = room.discard || [];
                for(let i = room.discard.length - 1; i >= 0; i--){ if(room.discard[i] && room.discard[i].id === (removed && removed.id)){ room.discard.splice(i,1); break; } }
              }catch(e){ console.error('restore removed card error', e); }
              return cb && cb({ error: 'no valid target' });
            }
            // compute affected squares: target + neighbors
            function neighbors(sq){
              if(!sq) return [];
              const m = String(sq).toLowerCase().match(/^([a-z])([0-9]+)$/i);
              if(!m) return [];
              const file = m[1].charCodeAt(0) - 'a'.charCodeAt(0);
              const rank = parseInt(m[2],10) - 1;
              const w = (board.width || 8), h = (board.height || 8);
              const out = [];
              for(let dx=-1; dx<=1; dx++) for(let dy=-1; dy<=1; dy++){
                const nx = file + dx, ny = rank + dy;
                if(nx<0||ny<0||nx>=w||ny>=h) continue;
                out.push(String.fromCharCode('a'.charCodeAt(0)+nx) + (ny+1));
              }
              return out;
            }
            const affected = neighbors(target);
            const removedPieces = [];
            // remove pieces on affected squares and record them as captured by sender
            for(let i = (board.pieces || []).length - 1; i >= 0; i--){
              const p = board.pieces[i];
              if(p && affected.indexOf(p.square) !== -1){
                const cp = board.pieces.splice(i,1)[0];
                try{
                  room.captured = room.captured || [];
                  const originalOwner = (room.players || []).find(pl => (pl.color && pl.color[0]) === cp.color);
                  room.captured.push({ id: uuidv4().slice(0,8), piece: cp, originalOwnerId: (originalOwner && originalOwner.id) || null, capturedBy: senderId, ts: Date.now() });
                }catch(_){ }
                removedPieces.push({ id: cp.id, square: cp.square, type: cp.type, color: cp.color });
              }
            }
            // bump board version and record effect
            board.version = (board.version || 0) + 1;
            const effect = { id: played.id, type: 'kamikaz', playerId: senderId, targetSquare: target, affectedSquares: affected, removed: removedPieces, ts: Date.now() };
            room.activeCardEffects = room.activeCardEffects || [];
            room.activeCardEffects.push(effect);
            try{ io.to(room.id).emit('card:effect:applied', { roomId: room.id, effect }); }catch(_){ }
            // reuse the mine detonation animation on clients for kamikaz: show the same explosion visual
            try{ io.to(room.id).emit('mine:detonated', { roomId: room.id, square: target }); }catch(_){ }
            played.payload = Object.assign({}, payload, { applied: 'kamikaz', appliedTo: target, affected: affected, removedCount: removedPieces.length });
            // After playing kamikaz the player immediately loses their turn (same behavior as steal-piece)
            try{
              if(board){
                board.turn = (board.turn === 'w') ? 'b' : 'w';
                // draw for the next player at the start of their turn
                const nextColor = board.turn;
                const nextPlayer = (room.players || []).find(p => (p.color && p.color[0]) === nextColor);
                if(nextPlayer){ try{ maybeDrawAtTurnStart(room, nextPlayer.id); }catch(_){ } }
              }
            }catch(_){ }
          }catch(e){ console.error('kamikaz effect error', e); }
        }
        // coin coin: teleport one of your pieces from a corner to another empty corner
        else if((typeof cardId === 'string' && (cardId.indexOf('coin') !== -1 || cardId.indexOf('coincoin') !== -1)) || cardId === 'coin_coin'){
          try{
            const board = room.boardState;
            let source = payload && payload.targetSquare;
            if(!source){ try{ source = socket.data && socket.data.lastSelectedSquare; }catch(e){ source = null; } }
            const roomPlayer = room.players.find(p => p.id === senderId);
            const playerColorShort = (roomPlayer && roomPlayer.color && roomPlayer.color[0]) || null;
            const piece = (board && board.pieces || []).find(p => p.square === source);
            // determine corner squares for the current board
            const w = (board && board.width) || 8;
            const h = (board && board.height) || 8;
            const left = 'a';
            const right = String.fromCharCode('a'.charCodeAt(0) + (w - 1));
            const corners = [ left + '1', left + String(h), right + '1', right + String(h) ];
            // validate source exists, belongs to the player and is on a corner
            if(!board || !source || !piece || piece.color !== playerColorShort || corners.indexOf(source) === -1){
              // invalid target: restore card to hand and abort
              try{
                room.hands = room.hands || {};
                room.hands[senderId] = room.hands[senderId] || [];
                if(removed) room.hands[senderId].push(removed);
                room.discard = room.discard || [];
                for(let i = room.discard.length - 1; i >= 0; i--){ if(room.discard[i] && room.discard[i].id === (removed && removed.id)){ room.discard.splice(i,1); break; } }
              }catch(e){ console.error('restore removed card error', e); }
              return cb && cb({ error: 'no valid corner piece selected' });
            }
            // find available destination corners (empty)
            const emptyCorners = corners.filter(c => { return !(board.pieces || []).some(p => p.square === c); });
            // remove the source corner from choices
            const destChoices = emptyCorners.filter(c => c !== source);
            if(!destChoices || destChoices.length === 0){
              // nothing to teleport to: restore card
              try{
                room.hands = room.hands || {};
                room.hands[senderId] = room.hands[senderId] || [];
                if(removed) room.hands[senderId].push(removed);
                room.discard = room.discard || [];
                for(let i = room.discard.length - 1; i >= 0; i--){ if(room.discard[i] && room.discard[i].id === (removed && removed.id)){ room.discard.splice(i,1); break; } }
              }catch(e){ console.error('restore removed card error', e); }
              return cb && cb({ error: 'no empty destination corner available' });
            }
            // instead of teleporting immediately, record an effect that grants this piece the ability
            // to move to any of the available corner squares for one turn
            const effect = { id: played.id, type: 'coincoin', playerId: senderId, pieceId: piece.id, pieceSquare: source, allowedSquares: destChoices.slice(0), remainingTurns: 1, ts: Date.now() };
            room.activeCardEffects = room.activeCardEffects || [];
            room.activeCardEffects.push(effect);
            // bump version so clients refresh legal moves when they request them
            board.version = (board.version || 0) + 1;
            try{ io.to(room.id).emit('card:effect:applied', { roomId: room.id, effect }); }catch(_){ }
            played.payload = Object.assign({}, payload, { applied: 'coincoin', from: source, allowed: destChoices.slice(0) });
          }catch(e){ console.error('coincoin effect error', e); }
        }
        // mélange: permute aléatoirement la position de toutes les pièces (échange entre cases occupées)
        else if((typeof cardId === 'string' && (cardId.indexOf('melange') !== -1 || cardId.indexOf('m\u00E9lange') !== -1 || cardId.indexOf('m\u00E9l') !== -1)) || cardId === 'melange' || cardId === 'm\u00E9lange'){
          try{
            const board = room.boardState;
            if(!board || !Array.isArray(board.pieces) || board.pieces.length === 0){
              // nothing to do; restore card
              try{
                room.hands = room.hands || {};
                room.hands[senderId] = room.hands[senderId] || [];
                if(removed) room.hands[senderId].push(removed);
                room.discard = room.discard || [];
                for(let i = room.discard.length - 1; i >= 0; i--){ if(room.discard[i] && room.discard[i].id === (removed && removed.id)){ room.discard.splice(i,1); break; } }
              }catch(_){ }
              return cb && cb({ error: 'no pieces to shuffle' });
            }
            // gather pieces and compute a random set of distinct destination squares across the whole board
            const pieces = board.pieces;
            const w = board.width || 8; const h = board.height || 8;
            // build full list of all squares on the board
            const allSquares = [];
            for(let yy = 0; yy < h; yy++){
              for(let xx = 0; xx < w; xx++){
                allSquares.push(String.fromCharCode('a'.charCodeAt(0) + xx) + (yy + 1));
              }
            }
            // if there are fewer available squares than pieces (shouldn't happen), abort gracefully
            if(allSquares.length < pieces.length){
              // can't place all pieces uniquely; leave board unchanged
              played.payload = Object.assign({}, payload, { applied: 'melange_failed', reason: 'board_too_small' });
            } else {
              // Fisher-Yates shuffle the full board squares and take first N distinct
              for(let i = allSquares.length - 1; i > 0; i--){ const j = Math.floor(Math.random() * (i + 1)); const tmp = allSquares[i]; allSquares[i] = allSquares[j]; allSquares[j] = tmp; }
              const dests = allSquares.slice(0, pieces.length);
              // assign destinations to pieces in random order
              const newSquareByPieceId = {};
              for(let i = 0; i < pieces.length; i++){ const p = pieces[i]; newSquareByPieceId[p.id] = dests[i]; }
              // apply new squares
              pieces.forEach(p => { try{ p.square = newSquareByPieceId[p.id] || p.square; }catch(_){ } });
              // update any active effects that are bound to pieces (by pieceId) so their pieceSquare follows
              try{
                room.activeCardEffects = room.activeCardEffects || [];
                room.activeCardEffects.forEach(e => {
                  if(!e) return;
                  try{ if(e.pieceId && newSquareByPieceId[e.pieceId]){ e.pieceSquare = newSquareByPieceId[e.pieceId]; } }catch(_){ }
                });
              }catch(_){ }
              played.payload = Object.assign({}, payload, { applied: 'melange', count: pieces.length });
              // bump board version and notify clients
              board.version = (board.version || 0) + 1;
              const effect = { id: played.id, type: 'melange', playerId: senderId, ts: Date.now(), note: 'pieces shuffled' };
              room.activeCardEffects = room.activeCardEffects || [];
              room.activeCardEffects.push(effect);
              try{ io.to(room.id).emit('card:effect:applied', { roomId: room.id, effect }); }catch(_){ }
            }
          }catch(e){ console.error('melange error', e); }
        }
        // révolution: transform pawns into (knight|bishop|rook) randomly, and knights/bishops/rooks into pawns
        else if((typeof cardId === 'string' && (cardId.indexOf('revol') !== -1 || cardId.indexOf('r\u00E9vol') !== -1)) || cardId === 'revolution' || cardId === 'r\u00E9volution'){
          try{
            const board = room.boardState;
            if(!board || !Array.isArray(board.pieces) || board.pieces.length === 0){
              // nothing to do; restore card
              try{
                room.hands = room.hands || {};
                room.hands[senderId] = room.hands[senderId] || [];
                if(removed) room.hands[senderId].push(removed);
                room.discard = room.discard || [];
                for(let i = room.discard.length - 1; i >= 0; i--){ if(room.discard[i] && room.discard[i].id === (removed && removed.id)){ room.discard.splice(i,1); break; } }
              }catch(_){ }
              return cb && cb({ error: 'no pieces to transform' });
            }
            const pieces = board.pieces;
            const transformChoices = ['N','B','R'];
            const mapping = [];
            for(let i = 0; i < pieces.length; i++){
              const p = pieces[i];
              if(!p || !p.type) continue;
              const t = ('' + p.type).toUpperCase();
              if(t === 'P'){
                // pawn -> random among N,B,R
                const choice = transformChoices[Math.floor(Math.random() * transformChoices.length)];
                p.type = choice;
                if(p.promoted) try{ delete p.promoted; }catch(_){ }
                mapping.push({ id: p.id, from: 'P', to: choice });
              } else if(t === 'N' || t === 'B' || t === 'R'){
                // knight/bishop/rook -> pawn
                p.type = 'P';
                if(p.promoted) try{ delete p.promoted; }catch(_){ }
                mapping.push({ id: p.id, from: t, to: 'P' });
              }
            }
            // bump version so clients refresh legal moves when they request them
            board.version = (board.version || 0) + 1;
            try{ io.to(room.id).emit('card:effect:applied', { roomId: room.id, effect: { id: played.id, type: 'revolution', mapping } }); }catch(_){ }
            played.payload = Object.assign({}, payload, { applied: 'revolution', mapping });
          }catch(e){ console.error('revolution effect error', e); }
        }
        // invisible: make one of your pieces invisible to the opponent for a number of turns
        else if(cardId === 'invisible' || (typeof cardId === 'string' && cardId.indexOf('invis') !== -1)){
          try{
            const board = room.boardState;
            let target = payload && payload.targetSquare;
            if(!target){ try{ target = socket.data && socket.data.lastSelectedSquare; }catch(e){ target = null; } }
            const roomPlayer = room.players.find(p => p.id === senderId);
            const playerColorShort = (roomPlayer && roomPlayer.color && roomPlayer.color[0]) || null;
            const targetPiece = (board && board.pieces || []).find(p => p.square === target);
            // validate target exists and belongs to the player
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
            // apply invisible effect bound to the piece id so only the owner can see it
            room.activeCardEffects = room.activeCardEffects || [];
            // Mark the piece object itself as invisible so the flag follows the piece when it moves
            try{ targetPiece.invisible = true; }catch(_){ }
            // Permanent invisible effect: do NOT set remainingTurns — the effect persists until explicitly removed by another action.
            const effect = { id: played.id, type: 'invisible', pieceId: targetPiece.id, pieceSquare: target, playerId: senderId, ts: Date.now() };
            room.activeCardEffects.push(effect);
            try{ io.to(room.id).emit('card:effect:applied', { roomId: room.id, effect }); }catch(_){ }
            played.payload = Object.assign({}, payload, { applied: 'invisible', appliedTo: target });
          }catch(e){ console.error('invisible effect error', e); }
        }
        // brouillard de guerre: target a player so their board is fogged (they only see adjacent squares)
        else if(cardId === 'brouillard_de_guerre' || (typeof cardId === 'string' && cardId.indexOf('brouillard') !== -1)){
          try{
            const board = room.boardState;
            // determine target player id: payload.targetPlayerId or the opponent
            let targetPlayerId = payload && payload.targetPlayerId;
            if(!targetPlayerId){
              const opp = (room.players || []).find(p => p.id !== senderId);
              targetPlayerId = opp && opp.id;
            }
            const targetPlayer = (room.players || []).find(p => p.id === targetPlayerId);
            if(!board || !targetPlayer || targetPlayer.id === senderId){
              // restore removed card to hand and abort
              try{ room.hands = room.hands || {}; room.hands[senderId] = room.hands[senderId] || []; if(removed) room.hands[senderId].push(removed); room.discard = room.discard || []; for(let i = room.discard.length-1;i>=0;i--){ if(room.discard[i] && room.discard[i].id === (removed && removed.id)){ room.discard.splice(i,1); break; } } }catch(e){}
              return cb && cb({ error: 'no valid target player' });
            }
            // record brouillard effect for target player
            room.activeCardEffects = room.activeCardEffects || [];
            const effect = { id: played.id, type: 'brouillard', playerId: targetPlayer.id, ts: Date.now(), remainingTurns: (payload && payload.turns) || 4 };
            room.activeCardEffects.push(effect);
            try{ io.to(room.id).emit('card:effect:applied', { roomId: room.id, effect }); }catch(_){}
            played.payload = Object.assign({}, payload, { applied: 'brouillard', appliedToPlayer: targetPlayer.id });
          }catch(e){ console.error('brouillard effect error', e); }
        }
        // anneau: make the board horizontally wrap for the playing player's pieces for this turn
        else if(cardId === 'anneau' || (typeof cardId === 'string' && cardId.indexOf('anneau') !== -1)){
          try{
            // record an anneau effect scoped to the player so their pieces gain wrap behavior
            room.activeCardEffects = room.activeCardEffects || [];
            const effect = { id: played.id, type: 'anneau', playerId: senderId, ts: Date.now(), remainingTurns: (payload && payload.turns) || 1 };
            room.activeCardEffects.push(effect);
            try{ io.to(room.id).emit('card:effect:applied', { roomId: room.id, effect }); }catch(_){}
            played.payload = Object.assign({}, payload, { applied: 'anneau' });
          }catch(e){ console.error('anneau effect error', e); }
        }
        // placement de mines: place a hidden mine on an empty square (hidden from other players)
        else if((typeof cardId === 'string' && cardId.indexOf('mine') !== -1)){
          try{
            const board = room.boardState;
            let target = payload && payload.targetSquare;
            if(!target){ try{ target = socket.data && socket.data.lastSelectedSquare; }catch(e){ target = null; } }
            // validate board and empty target
            const targetOccupied = (board && board.pieces || []).find(p => p.square === target);
            if(!board || !target || targetOccupied){
              // Invalid target: the card is still consumed (player loses the card as requested).
              // We do not restore the removed card to the player's hand. Record in played payload that the placement failed.
              played.payload = Object.assign({}, payload, { applied: 'mine_failed', attemptedTo: target });
              // Notify only the owner that the card was used but the mine was not placed
              try{ const owner = (room.players || []).find(p => p.id === senderId); if(owner && owner.socketId) io.to(owner.socketId).emit('card:effect:applied', { roomId: room.id, effect: { id: played.id, type: 'mine_failed', playerId: senderId, square: target, ts: Date.now() } }); }catch(_){ }
              // continue without creating a mine
            } else {
            // record mine effect scoped to the player; do NOT broadcast location to other players
            room.activeCardEffects = room.activeCardEffects || [];
            const effect = { id: played.id, type: 'mine', playerId: senderId, square: target, ts: Date.now() };
            room.activeCardEffects.push(effect);
            // notify only the owner about the mine placement (keep it hidden from opponents)
            try{
              const owner = (room.players || []).find(p => p.id === senderId);
              if(owner && owner.socketId) io.to(owner.socketId).emit('card:effect:applied', { roomId: room.id, effect });
            }catch(_){ }
            // for the public played record we mark the card as used without revealing the square
            played.payload = Object.assign({}, payload, { applied: 'mine' });
          }
        }catch(e){ console.error('mine placement error', e); }
        }
        // jouer deux fois: grant the playing player one extra move this turn (does not allow another card play)
        else if(cardId === 'jouer_deux_fois' || (typeof cardId === 'string' && cardId.indexOf('jouer') !== -1 && cardId.indexOf('deux') !== -1)){
          try{
            // record double-move effect scoped to the player
            room.activeCardEffects = room.activeCardEffects || [];
            const effect = { id: played.id, type: 'double_move', playerId: senderId, ts: Date.now(), remainingMoves: (payload && payload.moves) || 2 };
            room.activeCardEffects.push(effect);
            try{ io.to(room.id).emit('card:effect:applied', { roomId: room.id, effect }); }catch(_){ }
            played.payload = Object.assign({}, payload, { applied: 'double_move', moves: effect.remainingMoves });
          }catch(e){ console.error('double_move effect error', e); }
        }
  // vol de pièce: transfer ownership of a targeted enemy piece to the playing player
  // Note: do NOT handle "vole ... carte" here (steal-a-card) — that is handled by a separate branch below.
  else if((typeof cardId === 'string' && (cardId.indexOf('vol') !== -1 || cardId.indexOf('vole') !== -1 || cardId.indexOf('steal') !== -1) && !(cardId.indexOf('carte') !== -1 || cardId.indexOf('card') !== -1))){
          try{
            const board = room.boardState;
            let target = payload && payload.targetSquare;
            if(!target){ try{ target = socket.data && socket.data.lastSelectedSquare; }catch(e){ target = null; } }
            const roomPlayer = room.players.find(p => p.id === senderId);
            const playerColorShort = (roomPlayer && roomPlayer.color && roomPlayer.color[0]) || null;
            const targetPiece = (board && board.pieces || []).find(p => p.square === target);
            // validate target exists and belongs to the opponent and is not a king
            if(!board || !target || !targetPiece || targetPiece.color === playerColorShort || (targetPiece.type && String(targetPiece.type).toLowerCase() === 'k')){
              // Invalid target: by convention the card is consumed and not restored. Record failure in payload
              played.payload = Object.assign({}, payload, { applied: 'steal_failed', attemptedTo: target });
              // Notify only the owner that the card was used but the steal did not happen
              try{ const owner = (room.players || []).find(p => p.id === senderId); if(owner && owner.socketId) io.to(owner.socketId).emit('card:effect:applied', { roomId: room.id, effect: { id: played.id, type: 'steal_failed', playerId: senderId, square: target, ts: Date.now() } }); }catch(_){ }
              // continue without creating a steal effect
            } else {
            // perform the theft: change piece color to the player's color
            const oldColor = targetPiece.color;
            targetPiece.color = playerColorShort;

            // record a steal effect so clients can track it if needed
            room.activeCardEffects = room.activeCardEffects || [];
            const originalOwner = (room.players || []).find(p => (p.color && p.color[0]) === oldColor);
            const effect = { id: played.id, type: 'steal', pieceId: targetPiece.id, pieceSquare: target, fromColor: oldColor, toPlayerId: senderId, originalOwnerId: originalOwner && originalOwner.id, playerId: senderId, ts: Date.now() };
            room.activeCardEffects.push(effect);
            try{ io.to(room.id).emit('card:effect:applied', { roomId: room.id, effect }); }catch(_){ }

            played.payload = Object.assign({}, payload, { applied: 'steal', appliedTo: target, fromColor: oldColor });
            // after performing a piece-theft, the playing player immediately loses their turn
            try{
              if(board){
                board.turn = (board.turn === 'w') ? 'b' : 'w';
                // draw for the next player at the start of their turn
                const nextColor = board.turn;
                const nextPlayer = (room.players || []).find(p => (p.color && p.color[0]) === nextColor);
                if(nextPlayer){ try{ maybeDrawAtTurnStart(room, nextPlayer.id); }catch(_){ } }
              }
            }catch(_){ }
            }
          }catch(e){ console.error('steal effect error', e); }
        }
        // vole d'une carte: steal one random card from the target player's hand
        else if((typeof cardId === 'string' && cardId.indexOf('vole') !== -1 && (cardId.indexOf('carte') !== -1 || cardId.indexOf('card') !== -1))){
          try{
            // determine target player id: payload.targetPlayerId or pick the opponent
            let targetPlayerId = payload && payload.targetPlayerId;
            if(!targetPlayerId){ const opp = (room.players || []).find(p => p.id !== senderId); targetPlayerId = opp && opp.id; }
            const targetPlayer = (room.players || []).find(p => p.id === targetPlayerId);
            if(!targetPlayer || targetPlayer.id === senderId){
              // invalid target: consume card and notify owner
              played.payload = Object.assign({}, payload, { applied: 'steal_card_failed', attemptedTo: targetPlayerId });
              try{ const owner = (room.players || []).find(p => p.id === senderId); if(owner && owner.socketId) io.to(owner.socketId).emit('card:effect:applied', { roomId: room.id, effect: { id: played.id, type: 'steal_card_failed', playerId: senderId, targetPlayerId, ts: Date.now() } }); }catch(_){ }
            } else {
              room.hands = room.hands || {};
              const victimHand = room.hands[targetPlayerId] || [];
              if(!victimHand || victimHand.length === 0){
                // nothing to steal
                played.payload = Object.assign({}, payload, { applied: 'steal_card_failed_empty', attemptedTo: targetPlayerId });
                try{ const owner = (room.players || []).find(p => p.id === senderId); if(owner && owner.socketId) io.to(owner.socketId).emit('card:effect:applied', { roomId: room.id, effect: { id: played.id, type: 'steal_card_failed_empty', playerId: senderId, targetPlayerId, ts: Date.now() } }); }catch(_){ }
              } else {
                // pick random card from victim
                const idx = Math.floor(Math.random() * victimHand.length);
                const stolen = victimHand.splice(idx,1)[0];
                // give to stealer
                room.hands[senderId] = room.hands[senderId] || [];
                room.hands[senderId].push(stolen);
                played.payload = Object.assign({}, payload, { applied: 'steal_card', stolenFrom: targetPlayerId, stolenCardId: stolen.cardId || stolen.id });
                // inform the stealer privately about the stolen card details
                try{ const stealer = (room.players || []).find(p => p.id === senderId); if(stealer && stealer.socketId) io.to(stealer.socketId).emit('card:stolen', { roomId: room.id, from: targetPlayerId, card: stolen }); }catch(_){ }
                // inform the victim privately that they lost a card (do not reveal which)
                try{ const victim = (room.players || []).find(p => p.id === targetPlayerId); if(victim && victim.socketId) io.to(victim.socketId).emit('card:lost', { roomId: room.id, lostCount: 1 }); }catch(_){ }
              }
            }
            
          }catch(e){ console.error('steal-card effect error', e); }
          }
          // carte sans effet: consumed but does nothing
          else if((typeof cardId === 'string' && (cardId.indexOf('carte_sans_effet') !== -1 || cardId.indexOf('sans_effet') !== -1 || cardId.indexOf('no_effect') !== -1))){
            try{
              // no game state change; just inform the owner that the card was consumed with no effect
              played.payload = Object.assign({}, payload, { applied: 'no_effect' });
              try{ const owner = (room.players || []).find(p => p.id === senderId); if(owner && owner.socketId) io.to(owner.socketId).emit('card:effect:applied', { roomId: room.id, effect: { id: played.id, type: 'no_effect', playerId: senderId, ts: Date.now() } }); }catch(_){ }
            }catch(e){ console.error('no_effect card error', e); }
          }
          // resurrection: bring back one of your captured pieces and place it on an empty square
          else if((typeof cardId === 'string' && cardId.indexOf('resur') !== -1) || (typeof cardId === 'string' && cardId.indexOf('ressur') !== -1)){
            try{
              const roomPlayer = room.players.find(p => p.id === senderId);
              const playerColorShort = (roomPlayer && roomPlayer.color && roomPlayer.color[0]) || null;
              // list captured pieces that originally belonged to this player
              const available = (room.captured || []).filter(c => c && c.piece && c.piece.color === playerColorShort);
              if(!available || available.length === 0){
                played.payload = Object.assign({}, payload, { applied: 'resurrection_failed_no_captured' });
                try{ const owner = (room.players || []).find(p => p.id === senderId); if(owner && owner.socketId) io.to(owner.socketId).emit('card:effect:applied', { roomId: room.id, effect: { id: played.id, type: 'resurrection_failed_no_captured', playerId: senderId, ts: Date.now() } }); }catch(_){ }
              } else {
                // allow client to specify which captured entry to resurrect
                const selectedId = payload && (payload.captureId || payload.capturedId || payload.targetCapturedId || payload.selectedCapturedId);
                let capturedEntry = null;
                if(selectedId){
                  const idx = (room.captured || []).findIndex(c => c && c.id === selectedId && c.piece && c.piece.color === playerColorShort);
                  if(idx !== -1) capturedEntry = room.captured[idx];
                }
                if(!capturedEntry){
                  // fallback: pick the most recently captured of the player's pieces
                  capturedEntry = available[available.length - 1];
                }
                if(!capturedEntry){
                  played.payload = Object.assign({}, payload, { applied: 'resurrection_failed_no_valid' });
                  try{ const owner = (room.players || []).find(p => p.id === senderId); if(owner && owner.socketId) io.to(owner.socketId).emit('card:effect:applied', { roomId: room.id, effect: { id: played.id, type: 'resurrection_failed_no_valid', playerId: senderId, ts: Date.now() } }); }catch(_){ }
                } else {
                  // placement square
                  let target = payload && payload.targetSquare;
                  if(!target){ try{ target = socket.data && socket.data.lastSelectedSquare; }catch(e){ target = null; } }
                  const board = room.boardState;
                  const occupied = (board && board.pieces || []).find(p => p.square === target);
                  if(!board || !target || occupied){
                    // invalid placement: consume card but report failure to owner
                    played.payload = Object.assign({}, payload, { applied: 'resurrection_failed_bad_square', attemptedTo: target });
                    try{ const owner = (room.players || []).find(p => p.id === senderId); if(owner && owner.socketId) io.to(owner.socketId).emit('card:effect:applied', { roomId: room.id, effect: { id: played.id, type: 'resurrection_failed_bad_square', playerId: senderId, square: target, ts: Date.now() } }); }catch(_){ }
                  } else {
                    // remove captured entry from the capture log
                    for(let i = room.captured.length - 1; i >= 0; i--){ if(room.captured[i] && room.captured[i].id === capturedEntry.id){ room.captured.splice(i,1); break; } }
                    // create a new piece object and place it
                    const orig = capturedEntry.piece || {};
                    const newPiece = Object.assign({}, orig);
                    newPiece.id = ((playerColorShort === 'w') ? 'w_' : 'b_') + (newPiece.type || 'P') + '_' + uuidv4().slice(0,6);
                    newPiece.square = target;
                    newPiece.color = playerColorShort;
                    if(newPiece.promoted) newPiece.promoted = true;
                    board.pieces = board.pieces || [];
                    board.pieces.push(newPiece);
                    // record effect and broadcast
                    const effect = { id: played.id, type: 'resurrection', pieceId: newPiece.id, pieceType: newPiece.type, placedAt: target, playerId: senderId, ts: Date.now() };
                    room.activeCardEffects = room.activeCardEffects || [];
                    room.activeCardEffects.push(effect);
                    try{ io.to(room.id).emit('card:effect:applied', { roomId: room.id, effect }); }catch(_){ }
                    played.payload = Object.assign({}, payload, { applied: 'resurrection', appliedTo: target, resurrectedId: newPiece.id, resurrectedType: newPiece.type });
                  }
                }
              }
            }catch(e){ console.error('resurrection effect error', e); }
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
      room._cardPlayedThisTurn = room._cardPlayedThisTurn || {};
      room._cardPlayedThisTurn[played.playerId] = true;
    }
  }catch(e){ console.error('mark card played error', e); }
  // emit card played to entire room (informational)
  io.to(roomId).emit('card:played', played);
  // After playing a card, allow the player one free piece move that does NOT consume their turn.
  try{
    room._freeMoveFor = played.playerId; // client may use this flag to enable a free move UI
    // broadcast updated room state so clients can reflect the free-move opportunity
    sendRoomUpdate(room);
    try{ io.to(room.id).emit('card:free_move_allowed', { roomId: room.id, playerId: played.playerId }); }catch(_){ }
  }catch(e){ /* fallback */ sendRoomUpdate(room); }

    cb && cb({ ok: true, played });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`ChessNut server listening on port ${PORT}`);
});
