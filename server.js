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

// Public API: list available cards (uses the same deck builder as the server)
app.get('/cards', (req, res) => {
  try{
    const deck = buildDefaultDeck() || [];
    // Return a lightweight view (id, cardId, title, description)
    const out = deck.map(c => ({ id: c.id, cardId: c.cardId, title: c.title, description: c.description }));
    res.json({ ok: true, cards: out });
  }catch(e){ console.error('GET /cards error', e); res.status(500).json({ error: 'server_error' }); }
});

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
    noRemise: !!room.noRemise,
    deckCount: (room.deck && room.deck.length) || 0,
    discardCount: (room.discard && room.discard.length) || 0,
    previousDraws: room._playerDrewPrev || {},
    playerDrew: room._playerDrew || {},
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
        // If a 'tous_memes' effect is active for another player, mask pieces as kings for this recipient
        try{
          const effects = room.activeCardEffects || [];
          const tous = effects.find(e => e && e.type === 'tous_memes' && e.playerId && e.playerId !== p.id);
          if(tous && payload.boardState && Array.isArray(payload.boardState.pieces)){
            const masked = JSON.parse(JSON.stringify(payload.boardState));
            masked.pieces = masked.pieces.map(pc => { const c = Object.assign({}, pc); c.type = 'K'; return c; });
            payload.boardState = masked;
          }
        }catch(_){ }
      } else {
        payload.boardState = base.boardState || null;
      }
    }catch(_){ payload.boardState = base.boardState || null; }
        // attach visible squares for this recipient (fog of war)
    try{
        payload.visibleSquares = Array.from(visibleSquaresForPlayer(room, p.id) || []);
        // attach veiled squares if a brouillard effect targets this recipient
        try{
          const brouillards = (room.activeCardEffects || []).filter(e => e && e.type === 'brouillard');
          if(brouillards && brouillards.length){
            // If any brouillard is active in the room, veil the board for ALL players,
            // but exclude the recipient's visible squares (their pieces + adjacent squares).
            const state = room.boardState || {};
            const width = state.width || 8;
            const height = state.height || 8;
            const all = [];
            for(let yy = 0; yy < height; yy++){
              for(let xx = 0; xx < width; xx++){
                all.push(String.fromCharCode('a'.charCodeAt(0) + xx) + (yy+1));
              }
            }
            // compute the set of squares that the recipient can see (their pieces + adjacent squares)
            let visibleSet = new Set();
            try{
              const vs = visibleSquaresForPlayer(room, p.id) || new Set();
              visibleSet = new Set(Array.from(vs));
            }catch(_){ visibleSet = new Set(); }
            // veiled squares are all minus visibleSet (so own pieces and their neighbors remain visible)
            payload.veiledSquares = all.filter(sq => !visibleSet.has(sq));
          } else {
            payload.veiledSquares = [];
          }
        }catch(_){ payload.veiledSquares = []; }
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

// Helper to record whether a player drew during their turn and reset the current-turn marker.
function recordPlayerDrewPrev(room, playerId){
  try{
    room._playerDrewPrev = room._playerDrewPrev || {};
    room._playerDrew = room._playerDrew || {};
    room._playerDrewPrev[playerId] = !!room._playerDrew[playerId];
    room._playerDrew[playerId] = false;
  }catch(_){ }
}

// Helper: at the start of a player's turn, either perform an automatic draw
// if room.autoDraw is enabled, or simply broadcast the room state so clients
// can update UI. This centralizes the auto-draw toggle behavior.
function maybeDrawAtTurnStart(room, playerId){
  try{
    if(!room) return;
    if(room.autoDraw){
      const drawn = drawCardForPlayer(room, playerId);
      // if nothing was drawn (deck empty, hand full, or noRemise), still push a room update
      // so clients get the freshest state and don't remain out-of-sync.
      if(!drawn){
        try{ sendRoomUpdate(room); }catch(_){ }
      }
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

    // Shift the per-player draw marker: record whether the sender drew during their just-finished turn
    try{
      room._playerDrewPrev = room._playerDrewPrev || {};
      room._playerDrew = room._playerDrew || {};
      room._playerDrewPrev[senderId] = !!room._playerDrew[senderId];
      // clear the current-turn marker for the sender so it will be set anew on their next turn
      room._playerDrew[senderId] = false;
    }catch(_){ }

    // perform next player's draw (if autoDraw) or at least send room update
    try{ 
      const nextColor = board.turn;
      const nextPlayer = room.players.find(p => (p.color && p.color[0]) === nextColor);
      if(nextPlayer){ maybeDrawAtTurnStart(room, nextPlayer.id); } else { sendRoomUpdate(room); }
    }catch(_){ sendRoomUpdate(room); }
  }catch(e){ console.error('endTurnAfterCard error', e); }
}

// Check if a king is missing and end the game. Returns an object describing the outcome or null if game continues.
function checkAndHandleVictory(room){
  try{
    if(!room || !room.boardState) return null;
    // if the room is already finished, don't re-emit or change state
    if(room.status === 'finished') return null;
    const pieces = room.boardState.pieces || [];
    const hasWhiteKing = pieces.some(p => p && p.type && String(p.type).toUpperCase() === 'K' && p.color === 'w');
    const hasBlackKing = pieces.some(p => p && p.type && String(p.type).toUpperCase() === 'K' && p.color === 'b');
    if(hasWhiteKing && hasBlackKing) return null;
    // both missing -> draw
    if(!hasWhiteKing && !hasBlackKing){
      room.status = 'finished';
      try{ io.to(room.id).emit('game:over', { roomId: room.id, draw: true, boardState: room.boardState }); }catch(_){ }
      return { over: true, draw: true };
    }
    const winnerColor = hasWhiteKing ? 'w' : 'b';
    const loserColor = hasWhiteKing ? 'b' : 'w';
    const winner = (room.players || []).find(p => (p.color && p.color[0]) === winnerColor) || null;
    const loser = (room.players || []).find(p => (p.color && p.color[0]) === loserColor) || null;
    room.status = 'finished';
    try{ io.to(room.id).emit('game:over', { roomId: room.id, winnerId: winner && winner.id, loserId: loser && loser.id, winnerColor, boardState: room.boardState }); }catch(_){ }
    return { over: true, winnerId: winner && winner.id, loserId: loser && loser.id, winnerColor };
  }catch(e){ console.error('checkAndHandleVictory error', e); return null; }
}

// Each card has a unique id, cardId (slug), title and description.
function buildDefaultDeck(){
  const cards = [
    [
      'Rebondir sur les bords',
      'Les déplacements en diagonales de la pièce sélectionnée peuvent rebondir une fois sur les bords',
      'rebond'
    ],
    [
      'Adoubement',
      'La pièce sélectionnée peut maintenant faire les déplacements du cavalier en plus',
      'adoubement'
    ],
    [
      'Folie',
      'La pièce sélectionnée peut maintenant faire les déplacements du fou en plus',
      'folie'
    ],
    [
      'Fortification',
      'La pièce sélectionnée peut maintenant faire les déplacements de la tour en plus',
      'fortification'
    ],
    [
      "L'anneau",
      "Le plateau devient un anneau pendant un tour",
      "anneau"
    ],
    [
      'Brouillard de guerre',
      'Les joueur ne peuvent voir que au alentour de leurs pièces pendant 4 tours',
      'brouillard'
    ],
    [
      'Jouer deux fois',
      'Le joueur peut déplacer deux pièces. Ne peut pas capturer pendant son deuxième tour',
      'double'
    ],
    [
      "Totem d'immunité",
      "Annule l'effet de la prochaine carte jouée par l'adversaire",
      "totem"
    ],
    [
      'Placement de mines',
      'Le joueur place une mine sur une case vide sans la révéler au joueur adverse. Une pièce qui se pose dessus explose et est capturée par le joueur ayant placé la mine',
      'mine'
    ],
    [
      "Vole d'une pièce",
      'Désigne une pièce non roi qui change de camp.\n\nCompte comme un mouvement',
      'vole_piece'
    ],
    [
      'Promotion',
      'Un pion au choix est promu',
      'promotion'
    ],
    [
      "Vole d'une carte",
      'Vole une carte aléatoirement au joueur adverse',
      'vole_carte'
    ],
    [
      'Resurection',
      'Ressucite la dernière pièce perdue',
      'resurection'
    ],
    [
      'Carte sans effet',
      "N'a aucun effet",
      'sans_effet'
    ],
    [
      'Kamikaze',
      'Détruit une de ses pièces, détruisant toutes les pièces adjacentes.\n\nCompte comme un mouvement',
      'kamikaze'
    ],
    [
      'Invisible',
      "Une des pièces devient invisible pour l'adversaire",
      'invisible'
    ],
    [
      "Coin-Coin",
      "Possibilité de se téléporter depuis un coin vers n'importe quel autre coin",
      'coincoin'
    ],
    [
      'Téléportation',
      "Téléporte n'importe quelle pièce de son camp sur une case vide",
      'teleportation'
    ],
    [
      "Toucher c'est jouer",
      "Toucher une pièce adverse qu'il sera obligé de jouer",
      'toucher'
    ],
    [
      'Sniper',
      'Capturer une pièce sans avoir à bouger la pièce capturante',
      'sniper'
    ],
    [
      'Échange',
      "Échange la position d'une pièce avec une pièce adverse.\n\nCompte comme un mouvement",
      'inversion'
    ],
    [
      'Mélange',
      'La position de toutes les pièces sont échangées aléatoirement',
      'melange'
    ],
    [
      'La parrure',
      'Une reine est dégradée en pion',
      'parrure'
    ],
    [
      'Tout ou rien',
      'Une pièce choisie ne peut maintenant se déplacer que si elle capture.',
      'tout'
    ],
    [
      'Tous les mêmes',
      'Au yeux de l ennemie, toutes les pièces se ressemblent pendant 2 tours.',
      'pareil'
    ],
    [
      'Révolution',
      'Tous les pions sont aléatoirement changés en Cavalier, Fou ou Tour et les Cavaliers, Fous et Tours sont changés en pions.',
      'revolution'
    ],
    [
      "Doppelganger",
      "Choisis une pièce. À partir de maintenant, devient chacune des pièces qu'elle capture.",
      'doppelganger'
    ],

  // facile et intéresssant
    // ["intrication quantique","Deux pièces sont intriquées. Quand l'une bouge, l'autre bouge de la même manière."],
    // ['kurby','Choisis une pièce. À sa prochaine capture, récupère tous les mouvements de la pièce capturée.'],
    // ["cachotier", "La prochaine carte jouée ne sera pas révélée à l'adversaire."],
    // ['défausse','Le joueur adverse défausse une carte de son choix'],
    // ['glue','Toutes les pièces autour de la pièce désignée ne peuvent pas bouger tant que cette dernière ne bouge pas'],
    // ['immunité à la capture','Désigne une pièce qui ne pourra pas être capturée au prochain tour'],
    // ['marécage','Pendant X tours, toutes les pièces ne peuvent se déplacer que comme un roi'],
    // ['tricherie','Choisis une carte de la pioche parmis trois'],
    // ['trêve','Aucun capture ne peut avoir lieu pendant 4 tours'],
    // ['traversti','La pièce désignée change aléatoirement de type à chaque tour']
    // ['médusa','La pièce désignée ne peut plus bouger pendant 4 tours'],
    // ['pièce berserk','Une pièce choisie doit capturer dans les trois prochains tours, sinon elle est capturée'],

  // moyen facile mais intéressant
    // ['échange de main','Les deux joueurs échangent leurs mains'],
    // ["pièce fantôme","Choisis une pièce. Tant qu'elle ne capture pas, elle peut traverser les autres pièces comme si elles n'existaient pas."],
    // ['ça tangue','Toutes les pièces se décale du même côté'],
    // ['punching ball','Replace le roi dans sa position initiale, et place un nouveau pion à l ancienne position du roi'],
    // ['petit pion','Le joueur choisit un pion. À partir du prochain tour, il est promu en reine dès qu il capture un pièce non pion.'],

  // difficile mais intéressant
    // ['retour à la case départ','Désigne une pièce qui retourne à sa position initiale'],
    // ['changer la pièce à capturer','Le joueur choisie la nouvelle pièce jouant le rôle de roi sans la révéler'],
    // ['trou de ver','Deux cases du plateau deviennent maintenant la même'],
    // ['glissade','La pièce désignée ne peut plus s arrêter si elle se déplace en diagonale ou en ligne droite. Soit elle percute une pièce et la capture, soit elle tombe du plateau et est capturée'],
    // ['réinitialisation','Toutes les pièces reviennent à leur position initiale. S il y a des pièces supplémenaires, se rangent devant les pions'],
    // ['jeu des 7 différences','Déplace une pièce du plateau pendant que le joueur adverse à les yeux fermés. S il la retrouve, elle est capturée, laissée sinon'],
    
  // trop désequilibrant ou peu intéressant
    // ['épidémie','Toutes les pièces sur le territoire enemie est est capturée'],
    // ['vacances','Choisie une pièce qui sort du plateau pendant deux tours. Ce après quoi elle tente de revenir: si la case est occupée, alors la pièce vacancière est capturée par la pièce occupant la case.'],

  // a reflechir
    [
      'Empathie',
      'On retourne le plateau',
      'empathie'
    ], // pendant X tours ?
    // ['effet domino', "La pièce désigner peut rejouer tant qu'elle capture"]
    // ['reversi','Si deux pions encadrent parfaitement une pièce adverse, cette dernière change de camp'],
    // ['plus on est de fous','Si le joueur possède deux fous dans la même diagonale, alors toutes les pièces adverses encadrées par ces deux fous sont capturés'],
    // ['cluster','Désigne 4 pions formant un rectangle. Tant que ces pions ne bougent pas, aucune pièce ne peut sortir ou rentrer dans ce rectangle.'],
    // ['tronquer le plateau','Tronque au maximum le plateau sans supprimer de pièce'],
    // ['agrandir le plateau','Rajoute une rangée dans toutes les directions'],
  ];
  function cap(s){ if(!s) return s; s = String(s).trim(); return s.charAt(0).toUpperCase() + s.slice(1); }
  return cards.map(([title,desc,id])=>{
    const cardTitle = title;
    const cardDesc = desc;
    const cardId = id;
    const hidden = /mine|totem|invisible|immun|carte_sans_effet/i.test(cardId);
    return { id: cardId, title: cardTitle, description: cardDesc, hidden: !!hidden };
  });
}

function drawCardForPlayer(room, playerId){
  if(!room) return null;
  room.deck = room.deck || buildDefaultDeck();
  room.hands = room.hands || {};
  room.deck = room.deck || [];
  const hand = room.hands[playerId] || [];
  room._lastDrawForPlayer = room._lastDrawForPlayer || {};
  const boardVersion = (room.boardState && room.boardState.version) || null;
  if(boardVersion !== null && room._lastDrawForPlayer[playerId] === boardVersion){
    return null;
  }
  if(hand.length >= 5) return null; // hand full
  if(room.deck.length === 0){
    if(!room.noRemise && room.discard && room.discard.length > 0){
      room.deck = room.discard.splice(0).concat(room.deck || []);
      for(let i = room.deck.length - 1; i > 0; i--){
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = room.deck[i]; room.deck[i] = room.deck[j]; room.deck[j] = tmp;
      }
      (room.players || []).forEach(p => { if(p.socketId) io.to(p.socketId).emit('deck:reshuffled', { roomId: room.id, deckCount: room.deck.length }); });
    }
  }
  if(room.deck.length === 0) return null;
  for(let i = room.deck.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = room.deck[i]; room.deck[i] = room.deck[j]; room.deck[j] = tmp;
  }
  const idx = Math.floor(Math.random() * room.deck.length);
  const card = room.deck.splice(idx,1)[0];
  if(card && card.title){
    card.title = String(card.title).trim();
    card.title = card.title.charAt(0).toUpperCase() + card.title.slice(1);
  }
  room.hands[playerId] = room.hands[playerId] || [];
  room.hands[playerId].push(card);
  if(boardVersion !== null) room._lastDrawForPlayer[playerId] = boardVersion;
  const recipient = (room.players || []).find(p => p.id === playerId);
  if(recipient && recipient.socketId){
    io.to(recipient.socketId).emit('card:drawn', { playerId, card });
  }
  try{ if(room.autoDraw === false){ room._playerDrew = room._playerDrew || {}; room._playerDrew[playerId] = true; } }catch(_){ }
  sendRoomUpdate(room);
  return card;
}
function computeLegalMoves(room, square){
  if(!room || !room.boardState || !square) return [];
  const state = room.boardState;
  const width = state.width || 8;
  const height = state.height || 8;

  function squareToCoord(sq){
    if(!sq) return null;
    const s = String(sq).trim().toLowerCase();
    if(!/^[a-z][1-9][0-9]*$/.test(s)) return null;
    const file = s.charCodeAt(0) - 'a'.charCodeAt(0);
    const rank = parseInt(s.slice(1),10) - 1;
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
  const color = piece.color;
  const fromCoord = squareToCoord(square);
  if(!fromCoord) return [];
  const moves = [];

  const x = fromCoord.x, y = fromCoord.y;
  const type = (piece.type || '').toUpperCase();

  // coin coin
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

  // brouillard (fog of war) removed — moves are not filtered by fog

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
    return moves;
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
    return moves;
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
  const size = (req.body && parseInt(req.body.size, 10)) || 8;
  const boardState = size === 8 ? startingBoardState8() : null;
  const deck = buildDefaultDeck();
  rooms.set(id, { id, boardState, players: [], status: 'waiting', hostId: null, size, cards: {}, playedCards: [], removalTimers: new Map(), deck, hands: {}, autoDraw: false, noRemise: false });
  res.json({ roomId: id, size });
});

app.get('/rooms/:id', (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: 'room not found', message: "Aucune salle trouvée." });
    const boardState = room.boardState || null;
    const size = (room.boardState && room.boardState.width) || room.size;
  res.json({ id: room.id, boardState, size: size, players: room.players.map(p => ({ id: p.id, color: p.color })), status: room.status, hostId: room.hostId, cards: Object.keys(room.cards || {}), autoDraw: !!room.autoDraw, noRemise: !!room.noRemise });
});

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  socket.on('room:join', ({ roomId, playerId }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb && cb({ error: 'room not found', message: "Aucune salle trouvée." });
  const assignedId = playerId || uuidv4();

    if(room.removalTimers && room.removalTimers.has(assignedId)){
      clearTimeout(room.removalTimers.get(assignedId));
      room.removalTimers.delete(assignedId);
    }

    let existing = room.players.find(p => p.id === assignedId);

    let color;
    if(existing){
      existing.socketId = socket.id;
      color = existing.color;
    } else {
      color = room.players.length === 0 ? 'white' : 'black';
      room.players.push({ id: assignedId, socketId: socket.id, color });
    }
    room.hands = room.hands || {};
    if(!room.deck) room.deck = buildDefaultDeck();
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerId = assignedId;

    if (!room.hostId) room.hostId = assignedId;


    sendRoomUpdate(room);

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

  socket.on('room:leave', ({ roomId }, cb) => {
    try{
      const room = rooms.get(roomId || socket.data.roomId);
      const playerId = socket.data.playerId;
      if(!room) return cb && cb({ error: 'room not found', message: "Aucune salle trouvée." });
      if(!playerId) return cb && cb({ error: 'not joined', message: "Vous n'avez pas rejoint la salle." });
      room.players = (room.players || []).filter(p => p.id !== playerId);
      if(room.hostId && !room.players.find(p => p.id === room.hostId)){
        room.hostId = room.players[0] ? room.players[0].id : null;
      }
      if((room.players || []).length < 2 && room.status === 'playing') room.status = 'waiting';
      try{ socket.leave(room.id); }catch(_){ }
      try{ socket.data.roomId = null; }catch(_){ }
      try{ sendRoomUpdate(room); }catch(_){ }
      return cb && cb({ ok: true });
    }catch(e){ console.error('room:leave error', e); return cb && cb({ error: 'server_error' }); }
  });

  socket.on('room:auto_draw:set', ({ roomId, enabled }, cb) => {
    const room = rooms.get(roomId);
    if(!room) return cb && cb({ error: 'room not found', message: "Aucune salle trouvée." });
    const sender = socket.data.playerId;
    if(!sender) return cb && cb({ error: 'not joined', message: "Vous n'avez pas rejoint la salle." });
    if(room.hostId !== sender) return cb && cb({ error: 'only the host can change auto-draw', message: "Seul l'hôte peut changer le dessin automatique." });
    room.autoDraw = !!enabled;
    try{ sendRoomUpdate(room); }catch(_){ }
    try{ io.to(room.id).emit('room:auto_draw:changed', { roomId: room.id, enabled: room.autoDraw }); }catch(_){ }
    return cb && cb({ ok: true, autoDraw: room.autoDraw });
  });

  socket.on('room:no_remise:set', ({ roomId, enabled }, cb) => {
    const room = rooms.get(roomId);
    if(!room) return cb && cb({ error: 'room not found', message: "Aucune salle trouvée." });
    const sender = socket.data.playerId;
    if(!sender) return cb && cb({ error: 'not joined', message: "Vous n'avez pas rejoint la salle." });
    if(room.hostId !== sender) return cb && cb({ error: 'only the host can change no-remise', message: "Seul l'hôte peut changer le no-remise." });
    room.noRemise = !!enabled;
    try{ sendRoomUpdate(room); }catch(_){ }
    try{ io.to(room.id).emit('room:no_remise:changed', { roomId: room.id, enabled: room.noRemise }); }catch(_){ }
    return cb && cb({ ok: true, noRemise: room.noRemise });
  });

  socket.on('game:move', ({ roomId, from, to, promotion }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb && cb({ error: 'room not found', message: "Aucune salle trouvée." });
    if(room.status === 'finished') return cb && cb({ error: 'game_over', message: "La partie est terminée." });
    try{
      const senderId = socket.data.playerId;
      if(!senderId) return cb && cb({ error: 'not joined', message: "Vous n'avez pas rejoint la salle." });
      const roomPlayer = room.players.find(p => p.id === senderId);
      if(!roomPlayer) return cb && cb({ error: 'player not in room', message: "Vous n'êtes pas dans cette salle." });
      if(!room.boardState) return cb && cb({ error: 'no board state', message: "Aucun état de plateau disponible." });

      const board = room.boardState;
      const playerColorShort = (roomPlayer.color && roomPlayer.color[0]) || null;
      if(!playerColorShort) return cb && cb({ error: 'invalid player color' });

      if(board.turn !== playerColorShort) return cb && cb({ error: 'not your turn', message: "Ce n'est pas à votre tour de jouer." });

      const pieces = board.pieces || [];
      const moving = pieces.find(p => p.square === from);
      if(!moving) return cb && cb({ error: 'no piece at source' });
      if(moving.color !== playerColorShort) return cb && cb({ error: 'not your piece', message: "Vous ne pouvez pas déplacer une pièce adverse." });

      try{
        const effects = room.activeCardEffects || [];
        const toucher = effects.find(e => e && e.type === 'toucher' && e.playerId === senderId);
        if(toucher && toucher.pieceId && moving.id !== toucher.pieceId){
          return cb && cb({ error: 'must_move_restricted_piece', message: "Vous devez déplacer la pièce restreinte." });
        }
      }catch(_){ }

      // tout ou rien
      try{
        const effects2 = room.activeCardEffects || [];
        const tout = effects2.find(e => e && e.type === 'tout_ou_rien' && e.pieceId === moving.id);
            if(tout){
          const targetIndexCheck = pieces.findIndex(p => p.square === to);
          if(targetIndexCheck === -1){
            return cb && cb({ error: 'must_capture_to_move', message: "Mouvement impossible : cette pièce ne peut se déplacer que pour capturer une pièce adverse." });
          }
        }
      }catch(_){ }

      const legal = computeLegalMoves(room, from) || [];
      const ok = legal.some(m => m.to === to);
      if(!ok) return cb && cb({ error: 'illegal move', message: "Mouvement illégal." });
      try{
        const hasBrouillard = (room.activeCardEffects || []).some(e => e && e.type === 'brouillard');
        if(hasBrouillard){
          const visible = visibleSquaresForPlayer(room, senderId) || new Set();
          if(!visible.has(to)){
            return cb && cb({ error: 'destination_not_visible', message: "La destination n'est pas visible." });
          }
        }
      }catch(_){ }

      // Second move of "double"
      try{
        const effects = room.activeCardEffects || [];
        const dbl = effects.find(e => e && (e.type === 'double') && e.playerId === senderId);
        if(dbl && typeof dbl.remainingMoves === 'number' && dbl.remainingMoves === 1){
          const occupant = (pieces || []).find(p => p.square === to);
          if(occupant){
            return cb && cb({ error: 'capture_forbidden_double', message: "Vous ne pouvez pas capturer lors du deuxième mouvement de 'Jouer deux fois'." });
          }
        }
      }catch(_){ }

      const targetIndex = pieces.findIndex(p => p.square === to);
      let sniperTriggered = false;
      let capturedPieceForReactions = null;
      // sniper
      if(targetIndex >= 0){
        try{
          room.activeCardEffects = room.activeCardEffects || [];
          const sniperIdx = room.activeCardEffects.findIndex(e => e && e.type === 'sniper' && e.pieceId === moving.id && e.playerId === senderId);
          if(sniperIdx !== -1){
            const capturedPiece = pieces.splice(targetIndex, 1)[0];
              capturedPieceForReactions = capturedPiece;
            try{
              room.captured = room.captured || [];
              const originalOwner = (room.players || []).find(p => (p.color && p.color[0]) === capturedPiece.color);
              room.captured.push({ id: uuidv4().slice(0,8), piece: capturedPiece, originalOwnerId: (originalOwner && originalOwner.id) || null, capturedBy: senderId, ts: Date.now() });
              try{ if(capturedPiece && capturedPiece.invisible) delete capturedPiece.invisible; }catch(_){ }
            }catch(_){ /* ignore bookkeeping errors */ }
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
            try{
              const removedEffect = room.activeCardEffects.splice(sniperIdx, 1)[0];
              try{ io.to(room.id).emit('card:effect:removed', { roomId: room.id, effectId: removedEffect && removedEffect.id, type: 'sniper', playerId: removedEffect && removedEffect.playerId }); }catch(_){ }
            }catch(_){ }
            sniperTriggered = true;
            } else {
            const capturedPiece = pieces.splice(targetIndex, 1)[0];
              capturedPieceForReactions = capturedPiece;
            try{
              room.captured = room.captured || [];
              const originalOwner = (room.players || []).find(p => (p.color && p.color[0]) === capturedPiece.color);
              room.captured.push({ id: uuidv4().slice(0,8), piece: capturedPiece, originalOwnerId: (originalOwner && originalOwner.id) || null, capturedBy: senderId, ts: Date.now() });
              try{ if(capturedPiece && capturedPiece.invisible) delete capturedPiece.invisible; }catch(_){ }
            }catch(_){ /* ignore bookkeeping errors */ }
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
          const capturedPiece = pieces.splice(targetIndex, 1)[0];
            capturedPieceForReactions = capturedPiece;
          try{ room.captured = room.captured || []; const originalOwner = (room.players || []).find(p => (p.color && p.color[0]) === capturedPiece.color); room.captured.push({ id: uuidv4().slice(0,8), piece: capturedPiece, originalOwnerId: (originalOwner && originalOwner.id) || null, capturedBy: senderId, ts: Date.now() }); }catch(_){ }
        }
  }

  // doppelganger
  if(capturedPieceForReactions){
    try{
      room.activeCardEffects = room.activeCardEffects || [];
      const doppel = room.activeCardEffects.find(e => e && e.type === 'doppelganger' && e.pieceId === moving.id);
      if(doppel && capturedPieceForReactions && typeof capturedPieceForReactions.type !== 'undefined'){
        moving.type = capturedPieceForReactions.type;
        if(capturedPieceForReactions.promoted) {
          moving.promoted = true;
        } else if(moving.promoted){
          try{ delete moving.promoted; }catch(_){ }
        }
        doppel.pieceSquare = to;
        try{ io.to(room.id).emit('card:effect:updated', { roomId: room.id, effect: doppel }); }catch(_){ }
        try{ io.to(room.id).emit('card:effect:applied', { roomId: room.id, effect: Object.assign({}, doppel, { appliedType: capturedPieceForReactions.type }) }); }catch(_){ }
      }
    }catch(_){ }
  }

  if(!sniperTriggered){ moving.square = to; }

      try{
        room.activeCardEffects = room.activeCardEffects || [];
        for(let i = room.activeCardEffects.length - 1; i >= 0; i--){
          const e = room.activeCardEffects[i];
          if(e.type === 'rebond' && (e.pieceSquare === from || (e.pieceId && e.pieceId === moving.id))){
            room.activeCardEffects.splice(i,1);
            continue;
          }
          if(e.pieceId && e.pieceId === moving.id){
            e.pieceSquare = to;
          }
        }
      }catch(e){ console.error('consuming card effects error', e); }

      // mine
      try{
        room.activeCardEffects = room.activeCardEffects || [];
        for(let i = room.activeCardEffects.length - 1; i >= 0; i--){
          const e = room.activeCardEffects[i];
          if(e && e.type === 'mine' && e.square === to){
            const rmIdx = pieces.findIndex(p => p.id === moving.id);
            if(rmIdx >= 0){
              const capturedPiece = pieces.splice(rmIdx, 1)[0];
              try{
                room.captured = room.captured || [];
                const originalOwner = (room.players || []).find(p => (p.color && p.color[0]) === capturedPiece.color);
                room.captured.push({ id: uuidv4().slice(0,8), piece: capturedPiece, originalOwnerId: (originalOwner && originalOwner.id) || null, capturedBy: e.playerId, ts: Date.now() });
              }catch(_){ }
            }
            try{ room.activeCardEffects.splice(i,1); }catch(_){ }
            try{ io.to(roomId).emit('mine:detonated', { roomId: room.id, ownerId: e.playerId, detonatorId: senderId, square: to, piece: moving }); }catch(_){ }
            try{ const owner = (room.players||[]).find(p => p.id === e.playerId); if(owner && owner.socketId) io.to(owner.socketId).emit('mine:detonated:private', { roomId: room.id, effectId: e.id, square: to, piece: moving }); }catch(_){ }
            break;
          }
        }
      }catch(err){ console.error('mine detonation error', err); }

      board.version = (board.version || 0) + 1;

      // Update brouillard play counts
      try{
        room.activeCardEffects = room.activeCardEffects || [];
        for(let ei = room.activeCardEffects.length - 1; ei >= 0; ei--){
          const ev = room.activeCardEffects[ei];
          if(!ev || ev.type !== 'brouillard') continue;
          try{
            ev.playCounts = ev.playCounts || {};
            ev.playCounts[senderId] = (ev.playCounts[senderId] || 0) + 1;
            try{ io.to(room.id).emit('card:effect:updated', { roomId: room.id, effect: ev }); }catch(_){ }
            const threshold = 2;
            const players = room.players || [];
            let allReached = true;
            for(const pl of players){ if(!pl || !pl.id) continue; if((ev.playCounts[pl.id] || 0) < threshold){ allReached = false; break; } }
            if(allReached){
              try{ room.activeCardEffects.splice(ei,1); }catch(_){ }
              try{ io.to(room.id).emit('card:effect:removed', { roomId: room.id, effectId: ev.id, type: ev.type, playerId: ev.playerId }); }catch(_){ }
              try{ sendRoomUpdate(room); }catch(_){ }
            }
          }catch(_){ }
        }
      }catch(e){ console.error('brouillard playcount update error', e); }

      // victory check
      try{
        const end = checkAndHandleVictory(room);
        if(end && end.over){
          const moved = { playerId: senderId, from, to };
          try{ io.to(roomId).emit('move:moved', moved); }catch(_){ }
          try{ sendRoomUpdate(room); }catch(_){ }
          return cb && cb({ ok: true, moved, gameOver: end });
        }
      }catch(_){ }

      // double move
      let consumedDoubleMove = false;
      let freeMoveConsumed = false;
      try{
        if(room && room._freeMoveFor && room._freeMoveFor === senderId){
          freeMoveConsumed = true;
          try{ delete room._freeMoveFor; }catch(_){ room._freeMoveFor = null; }
          try{ io.to(room.id).emit('card:free_move_consumed', { roomId: room.id, playerId: senderId }); }catch(_){ }
        }
      }catch(e){ /* ignore */ }

      try{
        room.activeCardEffects = room.activeCardEffects || [];
        for(let i = room.activeCardEffects.length - 1; i >= 0; i--){
          const e = room.activeCardEffects[i];
          if((e.type === 'double') && e.playerId === senderId){
            const newRemaining = (typeof e.remainingMoves === 'number') ? (e.remainingMoves - 1) : ((e.remainingMoves || 2) - 1);
            if(newRemaining > 0){
              e.remainingMoves = newRemaining;
              consumedDoubleMove = true;
              try{ io.to(room.id).emit('card:effect:updated', { roomId: room.id, effect: e }); }catch(_){ }
            } else {
              try{
                room.activeCardEffects.splice(i,1);
              }catch(_){ }
              try{ io.to(room.id).emit('card:effect:removed', { roomId: room.id, effectId: e.id, type: e.type, playerId: e.playerId }); }catch(_){ }
            }
            break;
          }
        }
      }catch(err){ console.error('double move consume error', err); }

      if(!consumedDoubleMove){
        board.turn = (board.turn === 'w') ? 'b' : 'w';

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
                if(e.remainingTurns <= 0){
                  room.activeCardEffects.splice(i,1);
                  try{ io.to(room.id).emit('card:effect:removed', { roomId: room.id, effectId: e.id, type: e.type, playerId: e.playerId }); }catch(_){ }
                }
              }
            }
          }
        }catch(e){ console.error('updating temporary effects error', e); }

          try{ room._cardPlayedThisTurn = {}; }catch(_){ }
          // Record whether the sender drew during this turn so it will be available as "previous turn" for their next turn
          try{
            room._playerDrewPrev = room._playerDrewPrev || {};
            room._playerDrew = room._playerDrew || {};
            room._playerDrewPrev[senderId] = !!room._playerDrew[senderId];
            room._playerDrew[senderId] = false;
          }catch(_){ }
      }

      const moved = { playerId: senderId, from, to };
      try{
          if(!consumedDoubleMove){
          const nextColor = board.turn;
          const nextPlayer = room.players.find(p => (p.color && p.color[0]) === nextColor);
          if(nextPlayer){
            maybeDrawAtTurnStart(room, nextPlayer.id);
          } else {
            sendRoomUpdate(room);
          }
        } else {
          sendRoomUpdate(room);
        }
      }catch(e){
        console.error('draw-at-start-of-turn error', e);
      }

      io.to(roomId).emit('move:moved', moved);

      return cb && cb({ ok: true, moved });
    }catch(err){
      console.error('game:move error', err);
      return cb && cb({ error: 'server error' });
    }
  });

  socket.on('game:start', ({ roomId }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb && cb({ error: 'room not found', message: "La partie n'a pas été trouvée." });

    const senderId = socket.data.playerId;
    if (!senderId) return cb && cb({ error: 'not joined', message: "Vous n'avez pas rejoint la partie." });
    if (room.players.length < 2) return cb && cb({ error: 'need 2 players to start', message: "Il faut 2 joueurs pour commencer." });
    if (!room.hostId || room.hostId !== senderId) return cb && cb({ error: 'only host can start', message: "Seul l'hôte peut commencer la partie." });

    room.status = 'playing';
    io.to(roomId).emit('game:started', { roomId });
    sendRoomUpdate(room);

    try{
      if(room.boardState && room.boardState.turn){
        const firstColor = room.boardState.turn;
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

  socket.on('room:deck:set', ({ roomId, selected }, cb) => {
    const room = rooms.get(roomId);
    if(!room) return cb && cb({ error: 'room not found', message: "Aucune salle trouvée." });
    const sender = socket.data.playerId;
    if(!sender) return cb && cb({ error: 'not joined', message: "Vous n'avez pas rejoint la salle." });
    if(room.hostId !== sender) return cb && cb({ error: 'only host can set deck', message: "Seul l'hôte peut définir la pioche." });
    try{
      const sel = Array.isArray(selected) ? selected : [];
      const master = buildDefaultDeck();
      const pool = (room.deck && Array.isArray(room.deck) && room.deck.length) ? room.deck.concat(master) : master;
      const byId = {};
      pool.forEach(c => { if(c && c.id) byId[c.id] = c; if(c && c.cardId) byId[c.cardId] = c; });
      const newDeck = [];
      sel.forEach(sid => { const c = byId[sid]; if(c) newDeck.push(Object.assign({}, c)); });
      if(newDeck.length === 0){
        room.deck = buildDefaultDeck();
      } else {
        room.deck = newDeck;
      }
      room.discard = room.discard || [];
      sendRoomUpdate(room);
      return cb && cb({ ok: true, deckCount: room.deck.length });
    }catch(err){ console.error('room:deck:set error', err); return cb && cb({ error: 'server_error' }); }
  });

  socket.on('room:refresh', ({ roomId }, cb) => {
    try{
      const room = rooms.get(roomId);
      if(!room) return cb && cb({ error: 'room not found' });
      sendRoomUpdate(room);
      return cb && cb({ ok: true });
    }catch(e){ console.error('room:refresh error', e); return cb && cb({ error: 'server_error' }); }
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const playerId = socket.data.playerId;
    if(playerId && room.removalTimers){
      const t = setTimeout(()=>{
        room.players = room.players.filter(p => p.id !== playerId);
        if (room.hostId && !room.players.find(p => p.id === room.hostId)) {
          room.hostId = room.players[0] ? room.players[0].id : null;
        }
        if (room.players.length < 2 && room.status === 'playing') room.status = 'waiting';
        sendRoomUpdate(room);
        room.removalTimers.delete(playerId);
      }, 5000);
      room.removalTimers.set(playerId, t);
    } else {
      room.players = room.players.filter(p => p.socketId !== socket.id);
      if (room.players.length < 2 && room.status === 'playing') room.status = 'waiting';
      if (room.hostId && !room.players.find(p => p.id === room.hostId)) {
        room.hostId = room.players[0] ? room.players[0].id : null;
      }
      sendRoomUpdate(room);
    }
  });

  socket.on('game:legalMoves', ({ roomId, square }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb && cb({ error: 'room not found', message: "La partie n'a pas été trouvée." });
    try{
      const moves = computeLegalMoves(room, square) || [];
      return cb && cb({ ok: true, moves });
    }catch(e){
      console.error('game:legalMoves error', e);
      return cb && cb({ error: 'invalid square', moves: [], message: "La case sélectionnée est invalide." });
    }
  });

  socket.on('game:select', ({ roomId, square }, cb) => {
    const room = rooms.get(roomId);
    if(!room) return cb && cb({ error: 'room not found', message: "La partie n'a pas été trouvée." });
    const playerId = socket.data.playerId || null;
    try{ socket.data.lastSelectedSquare = square || null; }catch(e){}
    let moves = [];
    try{
      if(square){
        const effects = room.activeCardEffects || [];
        const isAffectedByTous = effects.some(e => e && e.type === 'pareil' && e.playerId && e.playerId !== playerId);
        if(isAffectedByTous){
          const tempRoom = Object.assign({}, room);
          tempRoom.boardState = JSON.parse(JSON.stringify(room.boardState || {}));
          if(Array.isArray(tempRoom.boardState.pieces)){
            tempRoom.boardState.pieces = tempRoom.boardState.pieces.map(pc => { const c = Object.assign({}, pc); c.type = 'K'; return c; });
          }
          moves = computeLegalMoves(tempRoom, square) || [];
        } else {
          moves = computeLegalMoves(room, square) || [];
        }
      }
    }catch(e){
      console.error('computeLegalMoves error', e);
      moves = [];
    }

    // toucher
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
    try{
      socket.emit('game:select', { playerId, square, moves });
      socket.to(roomId).emit('game:select', { playerId, square, moves: [] });
    }catch(e){
      io.to(roomId).emit('game:select', { playerId, square, moves: [] });
    }
    cb && cb({ ok: true });
  });

  // manual draw
  socket.on('player:draw', ({ roomId }, cb) => {
    const room = rooms.get(roomId);
    if(!room) return cb && cb({ error: 'room not found', message: "La partie n'a pas été trouvée." });
    if(room.status === 'finished') return cb && cb({ error: 'game_over', message: "La partie est terminée." });
    const senderId = socket.data.playerId;
    if(!senderId) return cb && cb({ error: 'not joined', message: "Vous n'avez pas rejoint la partie." });
    const board = room.boardState;
    if(!board) return cb && cb({ error: 'no board state', message: "L'état du plateau est introuvable." });
    const roomPlayer = room.players.find(p => p.id === senderId);
    if(!roomPlayer) return cb && cb({ error: 'player not in room', message: "Vous n'êtes pas dans cette partie." });
    const playerColorShort = (roomPlayer.color && roomPlayer.color[0]) || null;
    if(board.turn !== playerColorShort) return cb && cb({ error: 'not your turn', message: "Ce n'est pas à votre tour de jouer." });
    if(room.autoDraw) return cb && cb({ error: 'auto_draw_enabled', message: "Le tirage manuel n'est pas autorisé." });
    room._cardPlayedThisTurn = room._cardPlayedThisTurn || {};
    if(room._cardPlayedThisTurn[senderId]) return cb && cb({ error: 'card_already_played_this_turn', message: "Vous avez déjà joué une carte ce tour." });

    try{
      // If the player had drawn on their previous turn, disallow drawing now
      try{
        if(room._playerDrewPrev && room._playerDrewPrev[senderId]){
          try{ console.log('player:draw: rejected because player drew on previous turn (prev marker true) for', senderId); }catch(_){ }
          return cb && cb({ error: 'drew_last_turn', message: "Vous avez pioché lors de votre précédent tour et ne pouvez pas piocher maintenant." });
        }
      }catch(_){ }

      const drawn = drawCardForPlayer(room, senderId);
      if(!drawn){
        return cb && cb({ error: 'no_card_drawn', message: "Aucune carte n'a été tirée." });
      }
    board.version = (board.version || 0) + 1;
    room._cardPlayedThisTurn = room._cardPlayedThisTurn || {};
    room._cardPlayedThisTurn[senderId] = true;
    board.turn = (board.turn === 'w') ? 'b' : 'w';
    try{ room._cardPlayedThisTurn = {}; }catch(_){ }
    // Record whether the sender drew during this turn so it is available as "previous turn" for their next turn
    try{
      room._playerDrewPrev = room._playerDrewPrev || {};
      room._playerDrew = room._playerDrew || {};
      room._playerDrewPrev[senderId] = !!room._playerDrew[senderId];
      room._playerDrew[senderId] = false;
    }catch(_){ }
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

      const nextColor = board.turn;
      const nextPlayer = (room.players || []).find(p => (p.color && p.color[0]) === nextColor);
      if(nextPlayer){ try{ maybeDrawAtTurnStart(room, nextPlayer.id); }catch(_){ sendRoomUpdate(room); } }
      else { sendRoomUpdate(room); }

  try{ io.to(room.id).emit('player:drew', { roomId: room.id, playerId: senderId }); }catch(_){ }
      return cb && cb({ ok: true, card: drawn });
    }catch(err){ console.error('player:draw error', err); return cb && cb({ error: 'server_error' }); }
  });

  socket.on('card:list', ({ roomId }, cb) => {
    const room = rooms.get(roomId);
    if(!room) return cb && cb({ error: 'room not found', message: "La partie n'a pas été trouvée." });
    const available = [
      { id: 'invert', name: 'Invert Turn', description: 'Swap movement directions for one move' },
      { id: 'teleport', name: 'Teleport', description: 'Move one piece to any empty square' }
    ];
    cb && cb({ ok: true, cards: available });
  });

  socket.on('card:play', ({ roomId, playerId, cardId, payload }, cb) => {
    const room = rooms.get(roomId);
    if(!room) return cb && cb({ error: 'room not found', message: "La partie n'a pas été trouvée." });
    if(room.status === 'finished') return cb && cb({ error: 'game_over', message: "La partie est terminée." });
    const senderId = socket.data.playerId;
    if(!senderId) return cb && cb({ error: 'not joined', message: "Vous n'avez pas rejoint la partie." });
    try{
      const board = room.boardState;
      if(room.status === 'playing' && board){
        const roomPlayer = room.players.find(p => p.id === senderId);
        const playerColorShort = (roomPlayer && roomPlayer.color && roomPlayer.color[0]) || null;
        if(board.turn !== playerColorShort) return cb && cb({ error: 'not your turn', message: "Ce n'est pas à votre tour de jouer." });
        room._cardPlayedThisTurn = room._cardPlayedThisTurn || {};
        if(room._cardPlayedThisTurn[senderId]) return cb && cb({ error: 'card_already_played_this_turn', message: "Vous avez déjà joué une carte ce tour." });
      }
      
    }catch(e){ console.error('card play pre-check error', e); }
    const played = { id: uuidv4().slice(0,8), playerId: senderId, cardId, payload, ts: Date.now() };
    room.playedCards = room.playedCards || [];

    // cards needing target
    try{
      const isRebond = (typeof cardId === 'string') && (cardId.indexOf('rebond') !== -1);
      const isAdoub = (typeof cardId === 'string') && (cardId.indexOf('adoubement') !== -1);
      const isFolie = (typeof cardId === 'string') && (cardId.indexOf('folie') !== -1);
      const isFort = (typeof cardId === 'string') && (cardId.indexOf('fortification') !== -1);
      const isTargetCard = isRebond || isAdoub || isFolie || isFort;
      if(isTargetCard){
        const board = room.boardState;
        let targetCandidate = payload && payload.targetSquare;
        if(!targetCandidate){ try{ targetCandidate = socket.data && socket.data.lastSelectedSquare; }catch(e){ targetCandidate = null; } }
        const roomPlayer = room.players.find(p => p.id === senderId);
        const playerColorShort = (roomPlayer && roomPlayer.color && roomPlayer.color[0]) || null;
        const targetPiece = (board && board.pieces || []).find(p => p.square === targetCandidate);
        if(!board || !targetCandidate || !targetPiece || targetPiece.color !== playerColorShort){
          return cb && cb({ error: 'no valid target', message: "Aucune cible valide n'a été sélectionnée." });
        }
        payload = payload || {};
        payload.targetSquare = targetCandidate;
        played.payload = Object.assign({}, payload);
      }
    }catch(e){ console.error('target card pre-check error', e); }

    try{
      room.hands = room.hands || {};
      const hand = room.hands[senderId] || [];
      const idx = hand.findIndex(c => (c.id && c.id === (payload && payload.id)) || (c.cardId && c.cardId === cardId) || (c.id && c.id === cardId));
      if(idx === -1){
        return cb && cb({ error: 'you do not have that card', message: "Vous ne possedez pas cette carte." });
      }
      const removed = hand.splice(idx,1)[0];
      room.hands[senderId] = hand;
      room.discard = room.discard || [];
      if(!room.noRemise){
        room.discard.push(removed);
        played.card = removed;
        played._discarded = true;
      } else {
        played.card = removed;
        played._discarded = false;
      }
      
    cardId = (removed && removed.cardId) || cardId;
    }catch(e){
      console.error('card removal error', e);
    }

  // totem
  try{
    const active = room.activeCardEffects || [];
    const totems = active.filter(e => e && (e.type === 'totem'));
    if(totems && totems.length){
      const blocking = totems.find(t => t && t.playerId && t.playerId !== senderId);
      if(blocking){
        try{
          room.activeCardEffects = (room.activeCardEffects || []).filter(e => !(e && e.id === blocking.id));
        }catch(_){ }
        try{ io.to(room.id).emit('card:effect:removed', { roomId: room.id, effectId: blocking.id, type: 'totem', playerId: blocking.playerId }); }catch(_){ }
        try{ io.to(room.id).emit('card:play_blocked', { roomId: room.id, played, blockedBy: 'totem', protectedPlayerId: blocking.playerId }); }catch(_){ }
        try{ socket.emit('card:play_blocked:private', { ok: true, blocked: true, reason: 'totem', protectedPlayerId: blocking.playerId, message: 'Votre carte a été annulée par un totem d\'immunité.' }); }catch(_){ }
        try{
          const protectedPlayer = (room.players || []).find(p => p && p.id === blocking.playerId);
          if(protectedPlayer && protectedPlayer.socketId){
            io.to(protectedPlayer.socketId).emit('notification', { type: 'totem_consumed', roomId: room.id, message: 'Votre totem d\'immunité a annulé la dernière carte jouée par l\'adversaire.' });
          }
        }catch(_){ }
        try{ sendRoomUpdate(room); }catch(_){ }
        return cb && cb({ ok: true, blocked: true, reason: 'totem', protectedPlayerId: blocking.playerId });
      }
    }
  }catch(e){ console.error('totem immunity check error', e); }

  // board modification cards
  try{
      // adoubement
      if(cardId === 'adoubement'){
        try{
          const board = room.boardState;
          let target = payload && payload.targetSquare;
          if(!target){ try{ target = socket.data && socket.data.lastSelectedSquare; }catch(e){ target = null; } }
          const roomPlayer = room.players.find(p => p.id === senderId);
          const playerColorShort = (roomPlayer && roomPlayer.color && roomPlayer.color[0]) || null;
          const targetPiece = (board && board.pieces || []).find(p => p.square === target);
          if(!board || !target || !targetPiece || targetPiece.color !== playerColorShort){
            try{
              room.hands = room.hands || {};
              room.hands[senderId] = room.hands[senderId] || [];
              if(removed) room.hands[senderId].push(removed);
              room.discard = room.discard || [];
              for(let i = room.discard.length - 1; i >= 0; i--){ if(room.discard[i] && room.discard[i].id === (removed && removed.id)){ room.discard.splice(i,1); break; } }
            }catch(e){ console.error('restore removed card error', e); }
            return cb && cb({ error: 'no valid target', message: "Aucune cible valide n'a été sélectionnée." });
          }
          room.activeCardEffects = room.activeCardEffects || [];
          room.activeCardEffects.push({ id: played.id, type: 'adoubement', pieceId: targetPiece.id, pieceSquare: target, playerId: senderId });
          played.payload = Object.assign({}, payload, { applied: 'adoubement', appliedTo: target });
        }catch(e){ console.error('adoubement effect error', e); }
          }
      
      // doppelganger
      else if(cardId === 'doppelganger'){
        try{
          const board = room.boardState;
          let target = payload && payload.targetSquare;
          if(!target){ try{ target = socket.data && socket.data.lastSelectedSquare; }catch(e){ target = null; } }
          const roomPlayer = room.players.find(p => p.id === senderId);
          const playerColorShort = (roomPlayer && roomPlayer.color && roomPlayer.color[0]) || null;
          const targetPiece = (board && board.pieces || []).find(p => p.square === target);
          if(!board || !target || !targetPiece || targetPiece.color !== playerColorShort){
            try{
              room.hands = room.hands || {};
              room.hands[senderId] = room.hands[senderId] || [];
              if(removed) room.hands[senderId].push(removed);
              room.discard = room.discard || [];
              for(let i = room.discard.length - 1; i >= 0; i--){ if(room.discard[i] && room.discard[i].id === (removed && removed.id)){ room.discard.splice(i,1); break; } }
            }catch(e){ console.error('restore removed card error', e); }
            return cb && cb({ error: 'no valid target', message: "Aucune cible valide n'a été sélectionnée." });
          }
          try{
            room.activeCardEffects = room.activeCardEffects || [];
            const effect = { id: played.id, type: 'doppelganger', pieceId: targetPiece.id, pieceSquare: target, playerId: senderId };
            room.activeCardEffects.push(effect);
            try{ io.to(room.id).emit('card:effect:applied', { roomId: room.id, effect }); }catch(_){ }
            played.payload = Object.assign({}, payload, { applied: 'doppelganger', appliedTo: target });
          }catch(e){ console.error('apply persistent doppelganger error', e); played.payload = Object.assign({}, payload, { applied: 'doppelganger', appliedTo: target }); }
        }catch(e){ console.error('doppelganger minimal apply error', e); }
      }
          else if(cardId === 'folie' || (typeof cardId === 'string' && cardId.indexOf('folie') !== -1)){
            try{
              const board = room.boardState;
              let target = payload && payload.targetSquare;
              if(!target){ try{ target = socket.data && socket.data.lastSelectedSquare; }catch(e){ target = null; } }
              const roomPlayer = room.players.find(p => p.id === senderId);
              const playerColorShort = (roomPlayer && roomPlayer.color && roomPlayer.color[0]) || null;
              const targetPiece = (board && board.pieces || []).find(p => p.square === target);
              if(!board || !target || !targetPiece || targetPiece.color !== playerColorShort){
                try{
                  room.hands = room.hands || {};
                  room.hands[senderId] = room.hands[senderId] || [];
                  if(removed) room.hands[senderId].push(removed);
                  room.discard = room.discard || [];
                  for(let i = room.discard.length - 1; i >= 0; i--){ if(room.discard[i] && room.discard[i].id === (removed && removed.id)){ room.discard.splice(i,1); break; } }
                }catch(e){ console.error('restore removed card error', e); }
                return cb && cb({ error: 'no valid target', message: "Aucune cible valide n'a été sélectionnée." });
              }
              room.activeCardEffects = room.activeCardEffects || [];
              room.activeCardEffects.push({ id: played.id, type: 'folie', pieceId: targetPiece.id, pieceSquare: target, playerId: senderId });
              played.payload = Object.assign({}, payload, { applied: 'folie', appliedTo: target });
            }catch(e){ console.error('folie effect error', e); }
      }

      // fortification
      else if(cardId === 'fortification'){
        try{
          const board = room.boardState;
          let target = payload && payload.targetSquare;
          if(!target){ try{ target = socket.data && socket.data.lastSelectedSquare; }catch(e){ target = null; } }
          const roomPlayer = room.players.find(p => p.id === senderId);
          const playerColorShort = (roomPlayer && roomPlayer.color && roomPlayer.color[0]) || null;
          const targetPiece = (board && board.pieces || []).find(p => p.square === target);
          if(!board || !target || !targetPiece || targetPiece.color !== playerColorShort){
            try{
              room.hands = room.hands || {};
              room.hands[senderId] = room.hands[senderId] || [];
              if(removed) room.hands[senderId].push(removed);
              room.discard = room.discard || [];
              for(let i = room.discard.length - 1; i >= 0; i--){ if(room.discard[i] && room.discard[i].id === (removed && removed.id)){ room.discard.splice(i,1); break; } }
            }catch(e){ console.error('restore removed card error', e); }
            return cb && cb({ error: 'no valid target', message: "Aucune cible valide n'a été sélectionnée." });
          }
          room.activeCardEffects = room.activeCardEffects || [];
          room.activeCardEffects.push({ id: played.id, type: 'fortification', pieceId: targetPiece.id, pieceSquare: target, playerId: senderId });
          played.payload = Object.assign({}, payload, { applied: 'fortification', appliedTo: target });
        }catch(e){ console.error('fortification effect error', e); }
      }

      // toucher
      else if(cardId === 'toucher'){
        try{
          const board = room.boardState;
          let target = payload && payload.targetSquare;
          if(!target){ try{ target = socket.data && socket.data.lastSelectedSquare; }catch(e){ target = null; } }
          const roomPlayer = room.players.find(p => p.id === senderId);
          const playerColorShort = (roomPlayer && roomPlayer.color && roomPlayer.color[0]) || null;
          const targetPiece = (board && board.pieces || []).find(p => p.square === target);
          if(!board || !target || !targetPiece || targetPiece.color === playerColorShort){
            try{
              room.hands = room.hands || {};
              room.hands[senderId] = room.hands[senderId] || [];
              if(removed) room.hands[senderId].push(removed);
              room.discard = room.discard || [];
              for(let i = room.discard.length - 1; i >= 0; i--){ if(room.discard[i] && room.discard[i].id === (removed && removed.id)){ room.discard.splice(i,1); break; } }
            }catch(e){ console.error('restore removed card error', e); }
            return cb && cb({ error: 'no valid target', message: "Aucune cible valide n'a été sélectionnée." });
          }
          const targetOwner = (room.players || []).find(p => (p.color && p.color[0]) === targetPiece.color) || null;
          room.activeCardEffects = room.activeCardEffects || [];
          const effect = { id: played.id, type: 'toucher', playerId: (targetOwner && targetOwner.id) || null, pieceId: targetPiece.id, pieceSquare: targetPiece.square, remainingTurns: 1, decrementOn: 'owner', imposedBy: senderId, ts: Date.now() };
          room.activeCardEffects.push(effect);
          played.payload = Object.assign({}, payload, { applied: 'toucher', appliedTo: target });
          try{ io.to(room.id).emit('card:effect:applied', { roomId: room.id, effect }); }catch(_){ }
        }catch(e){ console.error('toucher effect error', e); }
        }

        // parrure
        else if(cardId === 'parrure'){
          try{
            const board = room.boardState;
            let target = payload && payload.targetSquare;
            if(!target){ try{ target = socket.data && socket.data.lastSelectedSquare; }catch(e){ target = null; } }
            const roomPlayer = room.players.find(p => p.id === senderId);
            const playerColorShort = (roomPlayer && roomPlayer.color && roomPlayer.color[0]) || null;
            const targetPiece = (board && board.pieces || []).find(p => p.square === target);
            if(!board || !target || !targetPiece || targetPiece.color === playerColorShort || !targetPiece.type || targetPiece.type.toLowerCase() !== 'q'){
              return cb && cb({ error: 'no valid target', message: "Aucune cible valide n'a été sélectionnée." });
            }
            try{
              targetPiece.type = 'p';
              if(targetPiece.promoted) delete targetPiece.promoted;
              try{ board.version = (board.version || 0) + 1; }catch(_){ }
              played.payload = Object.assign({}, payload, { applied: 'parrure', appliedTo: target });
              try{ io.to(room.id).emit('card:effect:applied', { roomId: room.id, effect: { id: played.id, type: 'parrure', pieceId: targetPiece.id, pieceSquare: targetPiece.square, playerId: senderId } }); }catch(_){ }
            }catch(e){ console.error('parrure apply error', e); }
          }catch(e){ console.error('parrure effect error', e); }
        }

        // sniper
        else if(cardId === 'sniper'){
          try{
            const board = room.boardState;
            let source = (payload && payload.sourceSquare) || (payload && payload.targetSquare) || null;
            if(!source){ try{ source = socket.data && socket.data.lastSelectedSquare; }catch(e){ source = null; } }
            const roomPlayer = room.players.find(p => p.id === senderId);
            const playerColorShort = (roomPlayer && roomPlayer.color && roomPlayer.color[0]) || null;
            const srcPiece = (board && board.pieces || []).find(p => p.square === source);
            if(!board || !source || !srcPiece || srcPiece.color !== playerColorShort){
              try{
                room.hands = room.hands || {};
                room.hands[senderId] = room.hands[senderId] || [];
                if(removed) room.hands[senderId].push(removed);
                room.discard = room.discard || [];
                for(let i = room.discard.length - 1; i >= 0; i--){ if(room.discard[i] && room.discard[i].id === (removed && removed.id)){ room.discard.splice(i,1); break; } }
              }catch(_){ }
              return cb && cb({ error: 'no valid source selected', message: "Aucune source valide n'a été sélectionnée." });
            }
            room.activeCardEffects = room.activeCardEffects || [];
            const effect = { id: played.id, type: 'sniper', playerId: senderId, pieceId: srcPiece.id, pieceSquare: srcPiece.square, remainingUses: 1, imposedBy: senderId, ts: Date.now() };
            room.activeCardEffects.push(effect);
            played.payload = Object.assign({}, payload, { applied: 'sniper_bound', appliedTo: source });
            try{ io.to(room.id).emit('card:effect:applied', { roomId: room.id, effect }); }catch(_){ }
          }catch(e){ console.error('sniper binding error', e); }
        }

        // tout ou rien
        else if(cardId === 'tout'){
          try{
            const board = room.boardState;
            let target = payload && payload.targetSquare;
            if(!target){ try{ target = socket.data && socket.data.lastSelectedSquare; }catch(e){ target = null; } }
            const targetPiece = (board && board.pieces || []).find(p => p.square === target);
            if(!board || !target || !targetPiece){
              return cb && cb({ error: 'no valid target', message: "Aucune cible valide n'a été sélectionnée." });
            }
            if(targetPiece.type && targetPiece.type.toLowerCase() === 'k'){
              return cb && cb({ error: 'cannot_target_king', message: "Vous ne pouvez pas cibler un roi." });
            }
            const targetOwner = (room.players || []).find(p => (p.color && p.color[0]) === targetPiece.color) || null;
            room.activeCardEffects = room.activeCardEffects || [];
            const effect = { id: played.id, type: 'tout_ou_rien', playerId: (targetOwner && targetOwner.id) || null, pieceId: targetPiece.id, pieceSquare: targetPiece.square, imposedBy: senderId, ts: Date.now() };
            room.activeCardEffects.push(effect);
            played.payload = Object.assign({}, payload, { applied: 'tout_ou_rien', appliedTo: target });
            try{ io.to(room.id).emit('card:effect:applied', { roomId: room.id, effect }); }catch(_){ }
          }catch(e){ console.error('tout_ou_rien effect error', e); }
        }

        // inversion
        else if(cardId === 'inversion'){
          try{
            const board = room.boardState;
            const payloadSrc = payload && payload.sourceSquare;
            const payloadTgt = payload && payload.targetSquare;
            let source = payloadSrc || null;
            let target = payloadTgt || null;
            if(!source){ try{ source = socket.data && socket.data.lastSelectedSquare; }catch(_){ source = null; } }
            if(!target){ /* nothing */ }
            const roomPlayer = room.players.find(p => p.id === senderId);
            const playerColorShort = (roomPlayer && roomPlayer.color && roomPlayer.color[0]) || null;
            const srcPiece = (board && board.pieces || []).find(p => p.square === source);
            const tgtPiece = (board && board.pieces || []).find(p => p.square === target);
            if(!board || !source || !target || !srcPiece || !tgtPiece || srcPiece.color !== playerColorShort || tgtPiece.color === playerColorShort){
              try{ room.hands = room.hands || {}; room.hands[senderId] = room.hands[senderId] || []; if(removed) room.hands[senderId].push(removed); room.discard = room.discard || []; for(let i = room.discard.length - 1; i >= 0; i--){ if(room.discard[i] && room.discard[i].id === (removed && removed.id)){ room.discard.splice(i,1); break; } } }catch(e){ console.error('restore removed card error', e); }
              return cb && cb({ error: 'no valid targets', message: "Aucune cible valide n'a été sélectionnée." });
            }
            try{
              const sSquare = srcPiece.square;
              const tSquare = tgtPiece.square;
              srcPiece.square = tSquare;
              tgtPiece.square = sSquare;
              try{
                room.activeCardEffects = room.activeCardEffects || [];
                room.activeCardEffects.forEach(e => {
                  try{
                    if(e && e.pieceSquare && e.pieceSquare === sSquare) e.pieceSquare = tSquare;
                    else if(e && e.pieceSquare && e.pieceSquare === tSquare) e.pieceSquare = sSquare;
                  }catch(_){ }
                });
              }catch(_){ }
              try{ board.version = (board.version || 0) + 1; }catch(_){ }
              played.payload = Object.assign({}, payload, { applied: 'inversion', from: source, to: target });
              try{ io.to(room.id).emit('card:effect:applied', { roomId: room.id, effect: { id: played.id, type: 'inversion', swapped: [srcPiece.id, tgtPiece.id], playerId: senderId } }); }catch(_){ }
            }catch(e){ console.error('inversion apply error', e); }
          }catch(e){ console.error('inversion effect error', e); }
      }

      // teleportation
      else if(cardId === 'teleportation'){
        try{
          const board = room.boardState;
          let target = payload && payload.targetSquare;
          if(!target){ try{ target = socket.data && socket.data.lastSelectedSquare; }catch(e){ target = null; } }
          const roomPlayer = room.players.find(p => p.id === senderId);
          const playerColorShort = (roomPlayer && roomPlayer.color && roomPlayer.color[0]) || null;
          const targetPiece = (board && board.pieces || []).find(p => p.square === target);
          if(!board || !target || !targetPiece || targetPiece.color !== playerColorShort){
            try{
              room.hands = room.hands || {};
              room.hands[senderId] = room.hands[senderId] || [];
              if(removed) room.hands[senderId].push(removed);
              room.discard = room.discard || [];
              for(let i = room.discard.length - 1; i >= 0; i--){ if(room.discard[i] && room.discard[i].id === (removed && removed.id)){ room.discard.splice(i,1); break; } }
            }catch(e){ console.error('restore removed card error', e); }
            return cb && cb({ error: 'no valid target', message: "Aucune cible valide n'a été sélectionnée." });
          }
          room.activeCardEffects = room.activeCardEffects || [];
          const effect = { id: played.id, type: 'teleport', pieceId: targetPiece.id, pieceSquare: target, playerId: senderId, remainingTurns: 1, decrementOn: 'owner' };
          room.activeCardEffects.push(effect);
          played.payload = Object.assign({}, payload, { applied: 'teleport', appliedTo: target });
          try{ io.to(room.id).emit('card:effect:applied', { roomId: room.id, effect }); }catch(_){ }
        }catch(e){ console.error('teleport effect error', e); }
        }

      // empathie
      else if(cardId === 'empathie'){
        try{
          const board = room.boardState;
          if(!board || !Array.isArray(board.pieces)){
            try{
              room.hands = room.hands || {};
              room.hands[senderId] = room.hands[senderId] || [];
              if(removed) room.hands[senderId].push(removed);
              room.discard = room.discard || [];
              for(let i = room.discard.length - 1; i >= 0; i--){ if(room.discard[i] && room.discard[i].id === (removed && removed.id)){ room.discard.splice(i,1); break; } }
            }catch(e){ }
            return cb && cb({ error: 'no board to flip', message: "Aucun plateau à retourner." });
          }
          function squareToCoord(sq){ if(!sq) return null; const s = String(sq).trim().toLowerCase(); if(!/^[a-z][1-9][0-9]*$/.test(s)) return null; const file = s.charCodeAt(0) - 'a'.charCodeAt(0); const rank = parseInt(s.slice(1),10) - 1; return { x: file, y: rank }; }
          function coordToSquare(x,y){ if(x<0||y<0||!board.width||!board.height) return null; if(x<0||y<0||x>=board.width||y>=board.height) return null; return String.fromCharCode('a'.charCodeAt(0) + x) + (y+1); }
          const w = board.width || 8; const h = board.height || 8;
          (board.pieces || []).forEach(p => {
            try{
              const c = squareToCoord(p.square);
              if(c){ const nx = (w - 1) - c.x; const ny = (h - 1) - c.y; const ns = coordToSquare(nx, ny); if(ns) p.square = ns; }
              p.color = (p.color === 'w' ? 'b' : (p.color === 'b' ? 'w' : p.color));
            }catch(_){ }
          });
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
          (room.players || []).forEach(pl => { try{ pl.color = (pl.color === 'white' ? 'black' : (pl.color === 'black' ? 'white' : pl.color)); }catch(_){ } });
          if(board.turn) board.turn = (board.turn === 'w' ? 'b' : (board.turn === 'b' ? 'w' : board.turn));
          board.version = (board.version || 0) + 1;
          const effect = { id: played.id, type: 'empathie', playerId: senderId, ts: Date.now() };
          room.activeCardEffects = room.activeCardEffects || [];
          room.activeCardEffects.push(effect);
          played.payload = Object.assign({}, payload, { applied: 'empathie' });
          try{ io.to(room.id).emit('card:effect:applied', { roomId: room.id, effect }); }catch(_){ }
          try{ recordPlayerDrewPrev(room, senderId); }catch(_){ }
        }catch(e){ console.error('empathie / changement de camp error', e); }
      }
        
      // promotion
        else if(cardId === 'promotion'){
          try{
            const board = room.boardState;
            let target = payload && payload.targetSquare;
            if(!target){ try{ target = socket.data && socket.data.lastSelectedSquare; }catch(e){ target = null; } }
            const roomPlayer = room.players.find(p => p.id === senderId);
            const playerColorShort = (roomPlayer && roomPlayer.color && roomPlayer.color[0]) || null;
            const targetPiece = (board && board.pieces || []).find(p => p.square === target);
            if(!board || !target || !targetPiece || targetPiece.color !== playerColorShort || (targetPiece.type && String(targetPiece.type).toLowerCase() !== 'p')){
              played.payload = Object.assign({}, payload, { applied: 'promotion_failed', attemptedTo: target });
              try{ const owner = (room.players || []).find(p => p.id === senderId); if(owner && owner.socketId) io.to(owner.socketId).emit('card:effect:applied', { roomId: room.id, effect: { id: played.id, type: 'promotion_failed', playerId: senderId, square: target, ts: Date.now() } }); }catch(_){ }
            } else {
              const oldType = targetPiece.type;
              const chosen = (payload && (payload.promotion || payload.targetPromotion || payload.promoteTo)) || 'q';
              const mapping = { q: 'q', r: 'r', b: 'b', n: 'n' };
              const toType = mapping[String(chosen).toLowerCase()] || 'q';
              targetPiece.type = toType;
              targetPiece.promoted = true;
              try{
                if(board){
                  board.turn = (board.turn === 'w') ? 'b' : 'w';
                  try{ recordPlayerDrewPrev(room, senderId); }catch(_){ }
                  const nextColor = board.turn;
                  const nextPlayer = (room.players || []).find(p => (p.color && p.color[0]) === nextColor);
                  if(nextPlayer){ try{ maybeDrawAtTurnStart(room, nextPlayer.id); }catch(_){ } }
                }
                const effect = { id: played.id, type: 'promotion', pieceId: targetPiece.id, pieceSquare: target, playerId: senderId, ts: Date.now() };
                room.activeCardEffects = room.activeCardEffects || [];
                room.activeCardEffects.push(effect);
                try{ io.to(room.id).emit('card:effect:applied', { roomId: room.id, effect }); }catch(_){ }
              }catch(_){ }
              played.payload = Object.assign({}, payload, { applied: 'promotion', appliedTo: target, fromType: oldType, toType: targetPiece.type });
            }
          }catch(e){ console.error('promotion effect error', e); }
        }

        // kamikaze
        else if(cardId === 'kamikaze'){
          try{
            const board = room.boardState;
            let target = payload && payload.targetSquare;
            if(!target){ try{ target = socket.data && socket.data.lastSelectedSquare; }catch(e){ target = null; } }
            const roomPlayer = room.players.find(p => p.id === senderId);
            const playerColorShort = (roomPlayer && roomPlayer.color && roomPlayer.color[0]) || null;
            const targetPiece = (board && board.pieces || []).find(p => p.square === target);
            if(!board || !target || !targetPiece || targetPiece.color !== playerColorShort){
              try{
                room.hands = room.hands || {};
                room.hands[senderId] = room.hands[senderId] || [];
                if(removed) room.hands[senderId].push(removed);
                room.discard = room.discard || [];
                for(let i = room.discard.length - 1; i >= 0; i--){ if(room.discard[i] && room.discard[i].id === (removed && removed.id)){ room.discard.splice(i,1); break; } }
              }catch(e){ console.error('restore removed card error', e); }
              return cb && cb({ error: 'no valid target', message: "Aucune cible valide n'a été sélectionnée." });
            }
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
            board.version = (board.version || 0) + 1;
            const effect = { id: played.id, type: 'kamikaz', playerId: senderId, targetSquare: target, affectedSquares: affected, removed: removedPieces, ts: Date.now() };
            room.activeCardEffects = room.activeCardEffects || [];
            room.activeCardEffects.push(effect);
            try{ io.to(room.id).emit('card:effect:applied', { roomId: room.id, effect }); }catch(_){ }
            try{ io.to(room.id).emit('mine:detonated', { roomId: room.id, square: target }); }catch(_){ }
            played.payload = Object.assign({}, payload, { applied: 'kamikaz', appliedTo: target, affected: affected, removedCount: removedPieces.length });
            try{
              const end = checkAndHandleVictory(room);
              if(end && end.over){
                try{ sendRoomUpdate(room); }catch(_){ }
              } else {
                if(board){
                  board.turn = (board.turn === 'w') ? 'b' : 'w';
                  try{ recordPlayerDrewPrev(room, senderId); }catch(_){ }
                  const nextColor = board.turn;
                  const nextPlayer = (room.players || []).find(p => (p.color && p.color[0]) === nextColor);
                  if(nextPlayer){ try{ maybeDrawAtTurnStart(room, nextPlayer.id); }catch(_){ } }
                }
              }
            }catch(_){ }
          }catch(e){ console.error('kamikaz effect error', e); }
        }

        // coin coin
        else if(cardId === 'coincoin'){
          try{
            const board = room.boardState;
            let source = payload && payload.targetSquare;
            if(!source){ try{ source = socket.data && socket.data.lastSelectedSquare; }catch(e){ source = null; } }
            const roomPlayer = room.players.find(p => p.id === senderId);
            const playerColorShort = (roomPlayer && roomPlayer.color && roomPlayer.color[0]) || null;
            const piece = (board && board.pieces || []).find(p => p.square === source);
            const w = (board && board.width) || 8;
            const h = (board && board.height) || 8;
            const left = 'a';
            const right = String.fromCharCode('a'.charCodeAt(0) + (w - 1));
            const corners = [ left + '1', left + String(h), right + '1', right + String(h) ];
            if(!board || !source || !piece || piece.color !== playerColorShort || corners.indexOf(source) === -1){
              try{
                room.hands = room.hands || {};
                room.hands[senderId] = room.hands[senderId] || [];
                if(removed) room.hands[senderId].push(removed);
                room.discard = room.discard || [];
                for(let i = room.discard.length - 1; i >= 0; i--){ if(room.discard[i] && room.discard[i].id === (removed && removed.id)){ room.discard.splice(i,1); break; } }
              }catch(e){ console.error('restore removed card error', e); }
              return cb && cb({ error: 'no valid corner piece selected', message: "Aucun coin valide n'a été sélectionné." });
            }
            const emptyCorners = corners.filter(c => { return !(board.pieces || []).some(p => p.square === c); });
            const destChoices = emptyCorners.filter(c => c !== source);
            if(!destChoices || destChoices.length === 0){
              try{
                room.hands = room.hands || {};
                room.hands[senderId] = room.hands[senderId] || [];
                if(removed) room.hands[senderId].push(removed);
                room.discard = room.discard || [];
                for(let i = room.discard.length - 1; i >= 0; i--){ if(room.discard[i] && room.discard[i].id === (removed && removed.id)){ room.discard.splice(i,1); break; } }
              }catch(e){ console.error('restore removed card error', e); }
              return cb && cb({ error: 'no empty destination corner available', message: "Aucun coin de destination vide n'est disponible." });
            }
            const effect = { id: played.id, type: 'coincoin', playerId: senderId, pieceId: piece.id, pieceSquare: source, allowedSquares: destChoices.slice(0), remainingTurns: 1, ts: Date.now() };
            room.activeCardEffects = room.activeCardEffects || [];
            room.activeCardEffects.push(effect);
            board.version = (board.version || 0) + 1;
            try{ io.to(room.id).emit('card:effect:applied', { roomId: room.id, effect }); }catch(_){ }
            played.payload = Object.assign({}, payload, { applied: 'coincoin', from: source, allowed: destChoices.slice(0) });
          }catch(e){ console.error('coincoin effect error', e); }
        }

        // mélange
        else if(cardId === 'melange'){
          try{
            const board = room.boardState;
            if(!board || !Array.isArray(board.pieces) || board.pieces.length === 0){
              try{
                room.hands = room.hands || {};
                room.hands[senderId] = room.hands[senderId] || [];
                if(removed) room.hands[senderId].push(removed);
                room.discard = room.discard || [];
                for(let i = room.discard.length - 1; i >= 0; i--){ if(room.discard[i] && room.discard[i].id === (removed && removed.id)){ room.discard.splice(i,1); break; } }
              }catch(_){ }
              return cb && cb({ error: 'no pieces to shuffle', message: "Aucune pièce à mélanger." });
            }
            const pieces = board.pieces;
            const w = board.width || 8; const h = board.height || 8;
            const allSquares = [];
            for(let yy = 0; yy < h; yy++){
              for(let xx = 0; xx < w; xx++){
                allSquares.push(String.fromCharCode('a'.charCodeAt(0) + xx) + (yy + 1));
              }
            }
            if(allSquares.length < pieces.length){
              played.payload = Object.assign({}, payload, { applied: 'melange_failed', reason: 'board_too_small' });
            } else {
              const occupiedByBlack = {};
              pieces.forEach(p => { try{ if(p && p.color === 'b' && p.square){ occupiedByBlack[p.square] = true; } }catch(_){ } });
              const occupiedByWhite = {};
              pieces.forEach(p => { try{ if(p && p.color === 'w' && p.square){ occupiedByWhite[p.square] = true; } }catch(_){ } });
              const blackSquares = Object.keys(occupiedByBlack);
              for(let i = blackSquares.length - 1; i > 0; i--){ const j = Math.floor(Math.random() * (i + 1)); const tmp = blackSquares[i]; blackSquares[i] = blackSquares[j]; blackSquares[j] = tmp; }
              const newBlackSquareByPieceId = {};
              let blackIndex = 0;
              pieces.forEach(p => { try{ if(p && p.color === 'b'){ newBlackSquareByPieceId[p.id] = blackSquares[blackIndex] || p.square; blackIndex++; } }catch(_){ } });
              const whiteSquares = Object.keys(occupiedByWhite);
              for(let i = whiteSquares.length - 1; i > 0; i--){ const j = Math.floor(Math.random() * (i + 1)); const tmp = whiteSquares[i]; whiteSquares[i] = whiteSquares[j]; whiteSquares[j] = tmp; }
              const newWhiteSquareByPieceId = {};
              let whiteIndex = 0;
              pieces.forEach(p => { try{ if(p && p.color === 'w'){ newWhiteSquareByPieceId[p.id] = whiteSquares[whiteIndex] || p.square; whiteIndex++; } }catch(_){ } });
              pieces.forEach(p => {
                try{
                  if(p && p.color === 'b' && newBlackSquareByPieceId[p.id]){
                    p.square = newBlackSquareByPieceId[p.id];
                  } else if(p && p.color === 'w' && newWhiteSquareByPieceId[p.id]){
                    p.square = newWhiteSquareByPieceId[p.id];
                  }
                }catch(_){ }
              });
              board.version = (board.version || 0) + 1;
              const effect = { id: played.id, type: 'melange', playerId: senderId, ts: Date.now() };
              room.activeCardEffects = room.activeCardEffects || [];
              room.activeCardEffects.push(effect);
              try{ io.to(room.id).emit('card:effect:applied', { roomId: room.id, effect }); }catch(_){ }
              played.payload = Object.assign({}, payload, { applied: 'melange' });
            }
          }catch(e){ console.error('melange error', e); }
        }

        // révolution
        else if(cardId === 'revolution'){
          try{
            const board = room.boardState;
            if(!board || !Array.isArray(board.pieces) || board.pieces.length === 0){
              try{
                room.hands = room.hands || {};
                room.hands[senderId] = room.hands[senderId] || [];
                if(removed) room.hands[senderId].push(removed);
                room.discard = room.discard || [];
                for(let i = room.discard.length - 1; i >= 0; i--){ if(room.discard[i] && room.discard[i].id === (removed && removed.id)){ room.discard.splice(i,1); break; } }
              }catch(_){ }
              return cb && cb({ error: 'no pieces to transform', message: "Aucune pièce à transformer." });
            }
            const pieces = board.pieces;
            const transformChoices = ['N','B','R'];
            const mapping = [];
            for(let i = 0; i < pieces.length; i++){
              const p = pieces[i];
              if(!p || !p.type) continue;
              const t = ('' + p.type).toUpperCase();
              if(t === 'P'){
                const choice = transformChoices[Math.floor(Math.random() * transformChoices.length)];
                p.type = choice;
                if(p.promoted) try{ delete p.promoted; }catch(_){ }
                mapping.push({ id: p.id, from: 'P', to: choice });
              } else if(t === 'N' || t === 'B' || t === 'R'){
                p.type = 'P';
                if(p.promoted) try{ delete p.promoted; }catch(_){ }
                mapping.push({ id: p.id, from: t, to: 'P' });
              }
            }
            board.version = (board.version || 0) + 1;
            try{ io.to(room.id).emit('card:effect:applied', { roomId: room.id, effect: { id: played.id, type: 'revolution', mapping } }); }catch(_){ }
            played.payload = Object.assign({}, payload, { applied: 'revolution', mapping });
          }catch(e){ console.error('revolution effect error', e); }
        }

        // invisible
        else if(cardId === 'invisible'){
          try{
            const board = room.boardState;
            let target = payload && payload.targetSquare;
            if(!target){ try{ target = socket.data && socket.data.lastSelectedSquare; }catch(e){ target = null; } }
            const roomPlayer = room.players.find(p => p.id === senderId);
            const playerColorShort = (roomPlayer && roomPlayer.color && roomPlayer.color[0]) || null;
            const targetPiece = (board && board.pieces || []).find(p => p.square === target);
            if(!board || !target || !targetPiece || targetPiece.color !== playerColorShort){
              try{
                room.hands = room.hands || {};
                room.hands[senderId] = room.hands[senderId] || [];
                if(removed) room.hands[senderId].push(removed);
                room.discard = room.discard || [];
                for(let i = room.discard.length - 1; i >= 0; i--){ if(room.discard[i] && room.discard[i].id === (removed && removed.id)){ room.discard.splice(i,1); break; } }
              }catch(e){ console.error('restore removed card error', e); }
              return cb && cb({ error: 'no valid target', message: "Aucune cible valide n'a été sélectionnée." });
            }
            room.activeCardEffects = room.activeCardEffects || [];
            try{ targetPiece.invisible = true; }catch(_){ }
            const effect = { id: played.id, type: 'invisible', pieceId: targetPiece.id, pieceSquare: target, playerId: senderId, ts: Date.now() };
            room.activeCardEffects.push(effect);
            try{ io.to(room.id).emit('card:effect:applied', { roomId: room.id, effect }); }catch(_){ }
            played.payload = Object.assign({}, payload, { applied: 'invisible', appliedTo: target });
          }catch(e){ console.error('invisible effect error', e); }
        }

      // brouillard
      else if(cardId === 'brouillard'){
        try{
              const board = room.boardState;
              let targetPlayerId = payload && payload.targetPlayerId;
              if(!targetPlayerId){
                const opp = (room.players || []).find(p => p.id !== senderId);
                targetPlayerId = opp && opp.id;
              }
              const targetPlayer = (room.players || []).find(p => p.id === targetPlayerId);
              if(!board || !targetPlayer || targetPlayer.id === senderId){
                try{ room.hands = room.hands || {}; room.hands[senderId] = room.hands[senderId] || []; if(removed) room.hands[senderId].push(removed); room.discard = room.discard || []; for(let i = room.discard.length-1;i>=0;i--){ if(room.discard[i] && room.discard[i].id === (removed && removed.id)){ room.discard.splice(i,1); break; } } }catch(e){}
                return cb && cb({ error: 'no valid target player', message: "Aucun joueur cible valide n'a été sélectionné." });
              }
              const width = board.width || 8;
              const height = board.height || 8;
              const all = [];
              for(let yy = 0; yy < height; yy++){
                for(let xx = 0; xx < width; xx++){
                  all.push(String.fromCharCode('a'.charCodeAt(0) + xx) + (yy+1));
                }
              }
              room.activeCardEffects = room.activeCardEffects || [];
              const playCounts = {};
              try{ (room.players || []).forEach(pl => { if(pl && pl.id) playCounts[pl.id] = 0; }); }catch(_){ }
              const effect = { id: played.id, type: 'brouillard', playerId: targetPlayer.id, ts: Date.now(), remainingTurns: (payload && payload.turns) || 4, veiledSquares: all, playCounts };
              room.activeCardEffects.push(effect);
              try{ io.to(room.id).emit('card:effect:applied', { roomId: room.id, effect }); }catch(_){ }
              played.payload = Object.assign({}, payload, { applied: 'brouillard', appliedToPlayer: targetPlayer.id });
            }catch(e){ console.error('brouillard effect error', e); }
        }

        // anneau
        else if(cardId === 'anneau'){
          try{
            room.activeCardEffects = room.activeCardEffects || [];
            const effect = { id: played.id, type: 'anneau', playerId: senderId, ts: Date.now(), remainingTurns: (payload && payload.turns) || 1 };
            room.activeCardEffects.push(effect);
            try{ io.to(room.id).emit('card:effect:applied', { roomId: room.id, effect }); }catch(_){}
            played.payload = Object.assign({}, payload, { applied: 'anneau' });
          }catch(e){ console.error('anneau effect error', e); }
        }

        // totem
        else if(cardId === 'totem'){
          try{
            room.activeCardEffects = room.activeCardEffects || [];
            const effect = { id: played.id, type: 'totem', playerId: senderId, ts: Date.now() };
            room.activeCardEffects.push(effect);
            try{ io.to(room.id).emit('card:effect:applied', { roomId: room.id, effect }); }catch(_){ }
            played.payload = Object.assign({}, payload, { applied: 'totem', appliedToPlayer: senderId });
          }catch(e){ console.error('totem effect error', e); }
        }

        //mine
        else if(cardId === 'mine'){
          try{
            const board = room.boardState;
            let target = payload && payload.targetSquare;
            if(!target){ try{ target = socket.data && socket.data.lastSelectedSquare; }catch(e){ target = null; } }
            const targetOccupied = (board && board.pieces || []).find(p => p.square === target);
            if(!board || !target || targetOccupied){
              played.payload = Object.assign({}, payload, { applied: 'mine_failed', attemptedTo: target });
              try{ const owner = (room.players || []).find(p => p.id === senderId); if(owner && owner.socketId) io.to(owner.socketId).emit('card:effect:applied', { roomId: room.id, effect: { id: played.id, type: 'mine_failed', playerId: senderId, square: target, ts: Date.now() } }); }catch(_){ }
            } else {
            room.activeCardEffects = room.activeCardEffects || [];
            const effect = { id: played.id, type: 'mine', playerId: senderId, square: target, ts: Date.now() };
            room.activeCardEffects.push(effect);
            try{
              const owner = (room.players || []).find(p => p.id === senderId);
              if(owner && owner.socketId) io.to(owner.socketId).emit('card:effect:applied', { roomId: room.id, effect });
            }catch(_){ }
            played.payload = Object.assign({}, payload, { applied: 'mine' });
          }
        }catch(e){ console.error('mine placement error', e); }
        }

        // jouer deux fois
        else if(cardId === 'double'){
          try{
            room.activeCardEffects = room.activeCardEffects || [];
            const effect = { id: played.id, type: 'double', playerId: senderId, ts: Date.now(), remainingMoves: (payload && payload.moves) || 2 };
            room.activeCardEffects.push(effect);
            try{ io.to(room.id).emit('card:effect:applied', { roomId: room.id, effect }); }catch(_){ }
            played.payload = Object.assign({}, payload, { applied: 'double', moves: effect.remainingMoves });
          }catch(e){ console.error('double effect error', e); }
        }

        // tous les même
        else if(cardId === 'pareil'){
          try{
            room.activeCardEffects = room.activeCardEffects || [];
            const effect = { id: played.id, type: 'tous_memes', playerId: senderId, ts: Date.now(), remainingTurns: (payload && payload.turns) || 2, decrementOn: 'opponent' };
            room.activeCardEffects.push(effect);
            try{ io.to(room.id).emit('card:effect:applied', { roomId: room.id, effect }); }catch(_){ }
            played.payload = Object.assign({}, payload, { applied: 'tous_memes', appliedToPlayer: senderId });
          }catch(e){ console.error('tous_memes effect error', e); }
        }

        // vole de pièce
        else if(cardId === 'vole_piece'){
          try{
            const board = room.boardState;
            let target = payload && payload.targetSquare;
            if(!target){ try{ target = socket.data && socket.data.lastSelectedSquare; }catch(e){ target = null; } }
            const roomPlayer = room.players.find(p => p.id === senderId);
            const playerColorShort = (roomPlayer && roomPlayer.color && roomPlayer.color[0]) || null;
            const targetPiece = (board && board.pieces || []).find(p => p.square === target);
            if(!board || !target || !targetPiece || targetPiece.color === playerColorShort || (targetPiece.type && String(targetPiece.type).toLowerCase() === 'k')){
              played.payload = Object.assign({}, payload, { applied: 'steal_failed', attemptedTo: target });
              try{ const owner = (room.players || []).find(p => p.id === senderId); if(owner && owner.socketId) io.to(owner.socketId).emit('card:effect:applied', { roomId: room.id, effect: { id: played.id, type: 'steal_failed', playerId: senderId, square: target, ts: Date.now() } }); }catch(_){ }
            } else {
            const oldColor = targetPiece.color;
            targetPiece.color = playerColorShort;

            room.activeCardEffects = room.activeCardEffects || [];
            const originalOwner = (room.players || []).find(p => (p.color && p.color[0]) === oldColor);
            const effect = { id: played.id, type: 'steal', pieceId: targetPiece.id, pieceSquare: target, fromColor: oldColor, toPlayerId: senderId, originalOwnerId: originalOwner && originalOwner.id, playerId: senderId, ts: Date.now() };
            room.activeCardEffects.push(effect);
            try{ io.to(room.id).emit('card:effect:applied', { roomId: room.id, effect }); }catch(_){ }

            played.payload = Object.assign({}, payload, { applied: 'steal', appliedTo: target, fromColor: oldColor });
            try{
              if(board){
                board.turn = (board.turn === 'w') ? 'b' : 'w';
                try{ recordPlayerDrewPrev(room, senderId); }catch(_){ }
                // draw for the next player at the start of their turn
                const nextColor = board.turn;
                const nextPlayer = (room.players || []).find(p => (p.color && p.color[0]) === nextColor);
                if(nextPlayer){ try{ maybeDrawAtTurnStart(room, nextPlayer.id); }catch(_){ } }
              }
            }catch(_){ }
            }
          }catch(e){ console.error('steal effect error', e); }
        }

        // vole d'une carte
        else if(cardId === 'vole_carte'){
          try{
            let targetPlayerId = payload && payload.targetPlayerId;
            if(!targetPlayerId){ const opp = (room.players || []).find(p => p.id !== senderId); targetPlayerId = opp && opp.id; }
            const targetPlayer = (room.players || []).find(p => p.id === targetPlayerId);
            if(!targetPlayer || targetPlayer.id === senderId){
              played.payload = Object.assign({}, payload, { applied: 'steal_card_failed', attemptedTo: targetPlayerId });
              try{ const owner = (room.players || []).find(p => p.id === senderId); if(owner && owner.socketId) io.to(owner.socketId).emit('card:effect:applied', { roomId: room.id, effect: { id: played.id, type: 'steal_card_failed', playerId: senderId, targetPlayerId, ts: Date.now() } }); }catch(_){ }
            } else {
              room.hands = room.hands || {};
              const victimHand = room.hands[targetPlayerId] || [];
              if(!victimHand || victimHand.length === 0){
                played.payload = Object.assign({}, payload, { applied: 'steal_card_failed_empty', attemptedTo: targetPlayerId });
                try{ const owner = (room.players || []).find(p => p.id === senderId); if(owner && owner.socketId) io.to(owner.socketId).emit('card:effect:applied', { roomId: room.id, effect: { id: played.id, type: 'steal_card_failed_empty', playerId: senderId, targetPlayerId, ts: Date.now() } }); }catch(_){ }
              } else {
                const idx = Math.floor(Math.random() * victimHand.length);
                const stolen = victimHand.splice(idx,1)[0];
                room.hands[senderId] = room.hands[senderId] || [];
                room.hands[senderId].push(stolen);
                played.payload = Object.assign({}, payload, { applied: 'steal_card', stolenFrom: targetPlayerId, stolenCardId: stolen.cardId || stolen.id });
                try{ const stealer = (room.players || []).find(p => p.id === senderId); if(stealer && stealer.socketId) io.to(stealer.socketId).emit('card:stolen', { roomId: room.id, from: targetPlayerId, card: stolen }); }catch(_){ }
                try{ const victim = (room.players || []).find(p => p.id === targetPlayerId); if(victim && victim.socketId) io.to(victim.socketId).emit('card:lost', { roomId: room.id, lostCount: 1 }); }catch(_){ }
              }
            }
            
          }catch(e){ console.error('steal-card effect error', e); }
          }

          // carte sans effet
          else if(cardId === 'sans_effet'){
            try{
              played.payload = Object.assign({}, payload, { applied: 'no_effect' });
              try{ const owner = (room.players || []).find(p => p.id === senderId); if(owner && owner.socketId) io.to(owner.socketId).emit('card:effect:applied', { roomId: room.id, effect: { id: played.id, type: 'no_effect', playerId: senderId, ts: Date.now() } }); }catch(_){ }
            }catch(e){ console.error('no_effect card error', e); }
          }

          // resurrection
          else if(cardId === 'resurection'){
            try{
              const roomPlayer = room.players.find(p => p.id === senderId);
              const playerColorShort = (roomPlayer && roomPlayer.color && roomPlayer.color[0]) || null;
              const available = (room.captured || []).filter(c => c && c.piece && c.piece.color === playerColorShort);
              if(!available || available.length === 0){
                played.payload = Object.assign({}, payload, { applied: 'resurrection_failed_no_captured' });
                try{ const owner = (room.players || []).find(p => p.id === senderId); if(owner && owner.socketId) io.to(owner.socketId).emit('card:effect:applied', { roomId: room.id, effect: { id: played.id, type: 'resurrection_failed_no_captured', playerId: senderId, ts: Date.now() } }); }catch(_){ }
              } else {
                const selectedId = payload && (payload.captureId || payload.capturedId || payload.targetCapturedId || payload.selectedCapturedId);
                let capturedEntry = null;
                if(selectedId){
                  const idx = (room.captured || []).findIndex(c => c && c.id === selectedId && c.piece && c.piece.color === playerColorShort);
                  if(idx !== -1) capturedEntry = room.captured[idx];
                }
                if(!capturedEntry){
                  capturedEntry = available[available.length - 1];
                }
                if(!capturedEntry){
                  played.payload = Object.assign({}, payload, { applied: 'resurrection_failed_no_valid' });
                  try{ const owner = (room.players || []).find(p => p.id === senderId); if(owner && owner.socketId) io.to(owner.socketId).emit('card:effect:applied', { roomId: room.id, effect: { id: played.id, type: 'resurrection_failed_no_valid', playerId: senderId, ts: Date.now() } }); }catch(_){ }
                } else {
                  let target = payload && payload.targetSquare;
                  if(!target){ try{ target = socket.data && socket.data.lastSelectedSquare; }catch(e){ target = null; } }
                  const board = room.boardState;
                  const occupied = (board && board.pieces || []).find(p => p.square === target);
                  if(!board || !target || occupied){
                    played.payload = Object.assign({}, payload, { applied: 'resurrection_failed_bad_square', attemptedTo: target });
                    try{ const owner = (room.players || []).find(p => p.id === senderId); if(owner && owner.socketId) io.to(owner.socketId).emit('card:effect:applied', { roomId: room.id, effect: { id: played.id, type: 'resurrection_failed_bad_square', playerId: senderId, square: target, ts: Date.now() } }); }catch(_){ }
                  } else {
                    for(let i = room.captured.length - 1; i >= 0; i--){ if(room.captured[i] && room.captured[i].id === capturedEntry.id){ room.captured.splice(i,1); break; } }
                    const orig = capturedEntry.piece || {};
                    const newPiece = Object.assign({}, orig);
                    newPiece.id = ((playerColorShort === 'w') ? 'w_' : 'b_') + (newPiece.type || 'P') + '_' + uuidv4().slice(0,6);
                    newPiece.square = target;
                    newPiece.color = playerColorShort;
                    if(newPiece.promoted) newPiece.promoted = true;
                    board.pieces = board.pieces || [];
                    board.pieces.push(newPiece);
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

      // rebond:
      else if(cardId === 'rebond'){
        try{
          const board = room.boardState;
          let target = payload && payload.targetSquare;
          if(!target){
            try{ target = socket.data && socket.data.lastSelectedSquare; }catch(e){ target = null; }
          }
          const roomPlayer = room.players.find(p => p.id === senderId);
          const playerColorShort = (roomPlayer && roomPlayer.color && roomPlayer.color[0]) || null;
          const targetPiece = (board && board.pieces || []).find(p => p.square === target);
          if(!board || !target || !targetPiece || targetPiece.color !== playerColorShort){
            try{
              room.hands = room.hands || {};
              room.hands[senderId] = room.hands[senderId] || [];
              if(removed) room.hands[senderId].push(removed);
              room.discard = room.discard || [];
              for(let i = room.discard.length - 1; i >= 0; i--){ if(room.discard[i] && room.discard[i].id === (removed && removed.id)){ room.discard.splice(i,1); break; } }
            }catch(e){ console.error('restore removed card error', e); }
            return cb && cb({ error: 'no valid target', message: "Aucune cible valide n'a été sélectionnée." });
          }
          room.activeCardEffects = room.activeCardEffects || [];
          room.activeCardEffects.push({ id: played.id, type: 'rebondir', pieceId: targetPiece.id, pieceSquare: target, playerId: senderId });
          played.payload = Object.assign({}, payload, { applied: 'rebondir', appliedTo: target });
        }catch(e){ console.error('rebondir effect error', e); }
      }
    }catch(e){
      console.error('card:play effect error', e);
    }

  room.playedCards.push(played);
    try{
    const board = room.boardState;
    if(room.status === 'playing' && board){
      room._cardPlayedThisTurn = room._cardPlayedThisTurn || {};
      room._cardPlayedThisTurn[played.playerId] = true;
    }
  }catch(e){ console.error('mark card played error', e); }
  io.to(roomId).emit('card:played', played);
  try{
    const countsAsMove = (cardId === 'inversion');
    if(countsAsMove){
      try{
        const board = room.boardState;
        if(board){
          board.turn = (board.turn === 'w') ? 'b' : 'w';
          try{ recordPlayerDrewPrev(room, senderId); }catch(_){ }

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
                  if(e.remainingTurns <= 0){
                    room.activeCardEffects.splice(i,1);
                    try{ io.to(room.id).emit('card:effect:removed', { roomId: room.id, effectId: e.id, type: e.type, playerId: e.playerId }); }catch(_){ }
                  }
                }
              }
            }
          }catch(err){ console.error('updating temporary effects error (inversion)', err); }

          try{ room._cardPlayedThisTurn = {}; }catch(_){ }

          try{
            const nextColor = board.turn;
            const nextPlayer = room.players.find(p => (p.color && p.color[0]) === nextColor);
            if(nextPlayer){
              maybeDrawAtTurnStart(room, nextPlayer.id);
            } else {
              sendRoomUpdate(room);
            }
          }catch(e){ sendRoomUpdate(room); }
        } else {
          sendRoomUpdate(room);
        }
      }catch(err){ console.error('inversion end-of-turn handling error', err); sendRoomUpdate(room); }
    } else {
      room._freeMoveFor = played.playerId; // client may use this flag to enable a free move UI
      sendRoomUpdate(room);
      try{ io.to(room.id).emit('card:free_move_allowed', { roomId: room.id, playerId: played.playerId }); }catch(_){ }
    }
  }catch(e){ /* fallback */ sendRoomUpdate(room); }

    cb && cb({ ok: true, played });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`ChessNut server listening on port ${PORT}`);
});

setInterval(() => {
  try{
    for(const [id, room] of rooms.entries()){
      try{
        if(!room) continue;
        if(room.status === 'finished') continue;
        const res = checkAndHandleVictory(room);
        if(res && res.over){
          try{ sendRoomUpdate(room); }catch(_){ }
        }
      }catch(e){ console.error('periodic room check error for', id, e); }
    }
  }catch(e){ console.error('periodic victory sweep error', e); }
}, 1000);
