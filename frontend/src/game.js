const q = s => document.querySelector(s);

// socket variable will be initialized on first load/join
let socket = null;
let myPlayerId = null;
let currentGameId = null;
let selected = null; // {x,y}

function renderBoardFromState(state) {
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

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const cell = document.createElement('div');
  cell.className = 'cell';
  // alternate light/dark based on coordinates (classic checkerboard)
  const isLight = ((r + c) % 2) === 1;
  cell.classList.add(isLight ? 'light' : 'dark');
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
      // clicks on cells should do absolutely nothing (display-only mode)
      cell.addEventListener('click', () => {
        // intentionally empty — do not select, do not emit moves, do not change UI
      });
    }
  }
  container.appendChild(boardEl);
  console.log('renderBoardFromState: board appended (w=' + w + ', h=' + h + ')');
}

function setMeta(text) { q('#meta').textContent = text; }

q('#create-only')?.addEventListener('click', async () => {
  const name = q('#game-name').value || 'game-from-ui';
  const res = await fetch('/api/create', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name, ownerNickname: 'ui-host' }) });
  const j = await res.json();
  setMeta('Created: ' + j.game.id);
  q('#game-id-input').value = j.game.id;
});

q('#create-start')?.addEventListener('click', async () => {
  const name = q('#game-name').value || 'game-from-ui';
  // create
  const createResp = await fetch('/api/create', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name, ownerNickname: 'ui-host' }) });
  const createJson = await createResp.json();
  const id = createJson.game.id;
  setMeta('Created: ' + id + ' — joining as second player...');
  // join as second player
  await fetch('/api/join', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id, nickname: 'ui-guest' }) });
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
  if (!socket) {
    socket = io();
    socket.on('connect', () => { socket.emit('join-game', currentGameId); socket.emit('identify', { gameId: currentGameId, playerId: myPlayerId }); });
    socket.on('game-state', (s) => { renderBoardFromState(s); setMeta('game-state updated'); });
    socket.on('move', (m) => { setMeta('remote move ' + JSON.stringify(m)); });
    socket.on('player-update', (g) => { setMeta('players updated'); });
    socket.on('error', (e) => { console.warn('socket error', e); setMeta('Socket error: ' + (e && e.error)); });
  }
});
