const q = s => document.querySelector(s);

// socket variable will be initialized on first load/join
let socket = null;
let myPlayerId = null;
let currentGameId = null;
let selected = null; // {x,y}

function renderBoardFromState(state, asWhite = null) {
  const container = q('#board-container');
  if(!container){ console.error('renderBoardFromState: #board-container not found'); return; }
  console.log('renderBoardFromState called, state present?', !!state);
  container.innerHTML = '';
  const boardEl = document.createElement('div');
  boardEl.className = 'board';

  // if no state provided, create an empty 8x8 board
  if(!state || !state.board){
    const w = 8, h = 8;
    const board = Array.from({ length: h }, () => Array.from({ length: w }, () => null));
    state = { board, width: w, height: h };
  }

  const h = state.height || state.board.length;
  const w = state.width || (state.board[0] && state.board[0].length) || 8;

  // Use CSS grid so cells distribute evenly and keep the board square via wrapper's aspect-ratio
  boardEl.style.display = 'grid';
  boardEl.style.gridTemplateColumns = `repeat(${w}, 1fr)`;
  boardEl.style.gridTemplateRows = `repeat(${h}, 1fr)`;
  // Keep cells square regardless of board dimensions by setting an aspect-ratio on the board element.
  // We want height / width ratio so each grid cell becomes square: aspect-ratio = h / w
  boardEl.style.aspectRatio = `${w} / ${h}`; // CSS aspect-ratio uses width/height, but grid tracks make squares when width/height ratio is set accordingly
  // Make the board responsive: max size will be limited by container width
  boardEl.style.maxWidth = 'min(90vmin, 80vw)';
  boardEl.style.width = '100%';

  // determine orientation: explicit asWhite param > window.myColor > default true
  try{
    let useWhite = true;
    if (asWhite === null) {
      if (window && window.myColor) useWhite = (String(window.myColor).toLowerCase() === 'white');
    } else {
      useWhite = !!asWhite;
    }
  console.log('[renderBoardFromState] myPlayerId=', myPlayerId, 'window.myColor=', window && window.myColor, 'asWhite param=', asWhite, 'computed useWhite=', useWhite);
  // set dataset for easier inspection in DevTools
  try { boardEl.dataset.orientation = useWhite ? 'white' : 'black'; container.dataset.myPlayerId = myPlayerId || ''; } catch(e) {}
  if (!useWhite) boardEl.classList.add('flipped');
  }catch(e){}

  // Render cells in visual order depending on orientation. We do not rotate the element; instead we map
  // visual coordinates -> state coordinates so piece images remain upright.
  const useWhite = (boardEl.dataset.orientation || 'white') === 'white' || (window && window.myColor && String(window.myColor).toLowerCase() === 'white');
  for (let vr = 0; vr < h; vr++) {
    for (let vc = 0; vc < w; vc++) {
      // Map visual row/col to state row/col depending on orientation
      // For white perspective we want white pieces at the bottom (state row 0 -> visual bottom),
      // so state row = h-1 - vr. For black perspective, state row = vr.
      const r = useWhite ? (h - 1 - vr) : vr;
      // For white perspective, file order is left->right = state col 0..w-1; for black it's mirrored.
      const c = useWhite ? vc : (w - 1 - vc);
      const cell = document.createElement('div');
      cell.className = 'cell';
      // alternate light/dark based on visual coordinates so checkerboard looks proper
      const isLight = ((vr + vc) % 2) === 0;
      cell.classList.add(isLight ? 'light' : 'dark');
      // store state coordinates so click handlers send correct moves
      cell.dataset.x = c;
      cell.dataset.y = r;
      const piece = document.createElement('img');
      piece.className = 'piece';

      const cellObj = state.board[r] && state.board[r][c];
      if (cellObj) {
        const t = cellObj.type || 'PAWN';
        const color = (cellObj.color || 'white').toLowerCase();
        const lookup = {
          PAWN: `assets/chess-pieces/chess_maestro_bw/${color[0] === 'w' ? 'wP' : 'bP'}.svg`,
          ROOK: `assets/chess-pieces/chess_maestro_bw/${color[0] === 'w' ? 'wR' : 'bR'}.svg`,
          KNIGHT: `assets/chess-pieces/chess_maestro_bw/${color[0] === 'w' ? 'wN' : 'bN'}.svg`,
          BISHOP: `assets/chess-pieces/chess_maestro_bw/${color[0] === 'w' ? 'wB' : 'bB'}.svg`,
          QUEEN: `assets/chess-pieces/chess_maestro_bw/${color[0] === 'w' ? 'wQ' : 'bQ'}.svg`,
          KING: `assets/chess-pieces/chess_maestro_bw/${color[0] === 'w' ? 'wK' : 'bK'}.svg`,
        };
        piece.src = lookup[t] || lookup.PAWN;
      } else {
        piece.style.display = 'none';
      }

      cell.appendChild(piece);
      boardEl.appendChild(cell);
      // click to select/move
      cell.addEventListener('click', () => {
        // if no game/socket, ignore
        if (!currentGameId) return;
        const x = parseInt(cell.dataset.x, 10);
        const y = parseInt(cell.dataset.y, 10);
        if (!selected) {
          selected = { x, y };
          cell.classList.add('selected');
          setMeta('Selected ' + x + ',' + y);
        } else {
          // send move
          const from = selected;
          const to = { x, y };
          selected = null;
          // clear previously selected class
          document.querySelectorAll('.cell.selected').forEach(el => el.classList.remove('selected'));
          setMeta('Sending move ' + from.x + ',' + from.y + ' -> ' + to.x + ',' + to.y);
          if (socket && myPlayerId && currentGameId) socket.emit('move', { gameId: currentGameId, playerId: myPlayerId, from, to });
        }
      });
    }
  }
  container.appendChild(boardEl);
  // ensure player color display is in sync
  try{ const pc = document.getElementById('player-color'); if(pc && window && window.myColor) pc.textContent = 'Couleur: ' + window.myColor; }catch(e){}
  console.log('renderBoardFromState: board appended (w=' + w + ', h=' + h + ')');
}

function setMeta(text) { q('#meta').textContent = text; }

function renderPlayersList(gameObj){
  try{
    const ul = document.getElementById('players-list'); if(!ul) return;
    ul.innerHTML = '';
    const players = (gameObj && gameObj.players) ? gameObj.players : [];
    players.forEach(p => {
      const li = document.createElement('li');
      li.textContent = (p.nickname || p.id) + ' — ' + (p.colorAssigned || 'non assignée');
      if(window && myPlayerId && p.id === myPlayerId) li.textContent += ' (vous)';
      ul.appendChild(li);
    });
  }catch(e){}
}

q('#create-only')?.addEventListener('click', async () => {
  const name = q('#game-name').value || 'game-from-ui';
  const res = await fetch('/api/create', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name, ownerNickname: 'ui-host' }) });
  const j = await res.json();
  setMeta('Created: ' + j.game.id);
  q('#game-id-input').value = j.game.id;
  // store owner player id in session so host remembers which player they are
  try{ if (j.player && j.game && j.player.id) { sessionStorage.setItem('chessnut:game:' + j.game.id + ':playerId', j.player.id); sessionStorage.setItem('playerId:' + j.game.id, j.player.id); } }catch(e){}
});

q('#create-start')?.addEventListener('click', async () => {
  const name = q('#game-name').value || 'game-from-ui';
  // create
  const createResp = await fetch('/api/create', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name, ownerNickname: 'ui-host' }) });
  const createJson = await createResp.json();
  const id = createJson.game.id;
  setMeta('Created: ' + id + ' — joining as second player...');
  // join as second player
  const joinResp = await fetch('/api/join', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id, nickname: 'ui-guest' }) });
  const joinJson = await joinResp.json();
  // if join returned a player object, use it as this client's player id (we're acting as the guest here)
  if (joinJson && joinJson.player && joinJson.player.id) {
    myPlayerId = joinJson.player.id;
    try{ sessionStorage.setItem('chessnut:game:' + id + ':playerId', myPlayerId); sessionStorage.setItem('playerId:' + id, myPlayerId); }catch(e){}
  }
  setMeta('Joined — starting...');
  const startResp = await fetch('/api/start', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id }) });
  const startJson = await startResp.json();
  setMeta('Started: ' + id);
  if (startJson.game && startJson.game.state) renderBoardFromState(startJson.game.state);
  // connect socket and join room as the guest player we created earlier
  currentGameId = id;
  // try to capture the second player id from server game.players
  const players = startJson.game.players || [];
  if (players[1]) myPlayerId = players[1].id; else if (players[0]) myPlayerId = players[0].id;
  // persist player id in sessionStorage (per-tab) so reloads can identify this client without colliding across tabs
  try{ if(myPlayerId && id) { sessionStorage.setItem('chessnut:game:' + id + ':playerId', myPlayerId); sessionStorage.setItem('playerId:' + id, myPlayerId); } }catch(e){}
  if (!socket) {
    socket = io();
    socket.on('connect', () => { socket.emit('join-game', currentGameId); socket.emit('identify', { gameId: currentGameId, playerId: myPlayerId }); });
    socket.on('game-state', (s) => { renderBoardFromState(s); setMeta('game-state updated'); });
    socket.on('move', (m) => { setMeta('remote move ' + JSON.stringify(m)); });
    socket.on('player-update', (g) => { setMeta('players updated'); });
    socket.on('error', (e) => { console.warn('socket error', e); setMeta('Socket error: ' + (e && e.error)); });
  }
});

q('#load')?.addEventListener('click', async () => {
  const id = q('#game-id-input').value;
  if(!id) return setMeta('Enter a game id');
  const res = await fetch('/api/game/' + id).catch(e => null);
  if(!res || !res.ok) return setMeta('Game not found or backend unreachable');
  const j = await res.json();
  setMeta('Loaded: ' + id + ' (started=' + !!j.started + ')');
  if (j.state && j.state.board) renderBoardFromState(j.state);
  // wire socket to listen to updates in this game
  currentGameId = id;
  // choose a player id if any exists (by default pick first)
  if (j.players && j.players.length > 0) myPlayerId = j.players[0].id;
  // prefer stored player id if present (sessionStorage is per-tab so two tabs won't collide)
  try{ const stored = sessionStorage.getItem('chessnut:game:' + id + ':playerId') || sessionStorage.getItem('playerId:' + id); if(stored) myPlayerId = stored; else if(myPlayerId && id) { sessionStorage.setItem('chessnut:game:' + id + ':playerId', myPlayerId); sessionStorage.setItem('playerId:' + id, myPlayerId); } }catch(e){}
  if (!socket) {
    socket = io();
    socket.on('connect', () => { socket.emit('join-game', currentGameId); socket.emit('identify', { gameId: currentGameId, playerId: myPlayerId }); });
    socket.on('game-state', (s) => { renderBoardFromState(s); setMeta('game-state updated'); });
    socket.on('move', (m) => { setMeta('remote move ' + JSON.stringify(m)); });
    socket.on('player-update', (g) => { setMeta('players updated'); });
    socket.on('error', (e) => { console.warn('socket error', e); setMeta('Socket error: ' + (e && e.error)); });
  }
});
