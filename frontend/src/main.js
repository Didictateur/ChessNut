// Minimal frontend to create/join a game and render a static board using chess_maestro pieces
const q = s => document.querySelector(s);

function showLobby() {
  q('#lobby').classList.remove('hidden');
  q('#board-section')?.classList?.add('hidden');
}

function showBoard(gameId, role) {
  q('#lobby').classList.add('hidden');
  q('#board-section')?.classList?.remove('hidden');
  q('#game-id').textContent = gameId;
  q('#player-role').textContent = role;
  renderBoard(role === 'white');
}

q('#create-btn').addEventListener('click', () => {
  console.log('[frontend] create-btn clicked');
  const id = 'game-' + Math.random().toString(36).slice(2,9);
  const pass = q('#create-pass').value;
  const name = q('#create-name').value || id;
  // minimal create: no prompts, use default host nickname
  const nick = 'Host';
  const colorChoice = 'random';
  const game = { id, name, pass: pass || null, owner: 'you', created: Date.now(), players: [{ id: 'p-' + Math.random().toString(36).slice(2,6), nickname: nick, colorChoice, colorAssigned: null }], started: false };

  // try backend first (explicit host). If it fails, save locally and redirect to waiting page.
  fetch('http://localhost:4000/api/create', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({name, pass, ownerNickname: nick, ownerColorChoice: colorChoice}) })
    .then(r => { console.log('[frontend] backend /api/create response', r.status); if(!r.ok) throw new Error('no api'); return r.json(); })
    .then(g => { console.log('[frontend] created (backend)', g); alert('Partie créée: ' + g.id); window.location.href = `waiting.html?game=${g.id}`; })
    .catch((err) => {
      console.warn('[frontend] backend create failed, saving locally and redirecting', err && err.message);
      // save to localStorage so waiting page can pick it up
      const all = JSON.parse(localStorage.getItem('games') || '[]');
      all.push(game);
      localStorage.setItem('games', JSON.stringify(all));
      alert('Partie créée localement: ' + game.id);
      window.location.href = `waiting.html?game=${game.id}`;
    });
});

q('#show-list-btn').addEventListener('click', () => {
  const list = q('#games-list');
  list.classList.toggle('hidden');
  renderGameList();
});

function saveGame(game){
  const all = JSON.parse(localStorage.getItem('games') || '[]');
  all.push(game);
  localStorage.setItem('games', JSON.stringify(all));
}

function renderGameList(){
  const ul = q('#games-ul');
  ul.innerHTML = '';
  console.log('[frontend] renderGameList called');
  // prefer backend host in dev
  fetch('http://localhost:4000/api/list')
    .then(r => { if(!r.ok) throw new Error('no remote api'); return r.json(); })
    .then(all => { if(!all || all.length === 0){ ul.innerHTML = '<li>Aucune partie disponible</li>'; return; } all.forEach(g => renderGameListItem(ul, g)); })
    .catch(() => {
      // try same-origin then localStorage
      fetch('/api/list')
        .then(r => { if(!r.ok) throw new Error('no local api'); return r.json(); })
        .then(all => { if(!all || all.length === 0){ ul.innerHTML = '<li>Aucune partie disponible</li>'; return; } all.forEach(g => renderGameListItem(ul, g)); })
        .catch(() => {
          const all = JSON.parse(localStorage.getItem('games') || '[]');
          if(all.length === 0){ ul.innerHTML = '<li>Aucune partie disponible</li>'; return; }
          all.forEach(g => renderGameListItem(ul, g));
        });
    });
}

function renderGameListItem(ul, g){
  const li = document.createElement('li');
  li.textContent = `${g.name} (${g.id})`;
  const btn = document.createElement('button');
  btn.textContent = 'Rejoindre';
  btn.addEventListener('click', () => {
    console.log('[frontend] join clicked for', g.id);
    if(g.pass){ const entered = prompt('Mot de passe pour rejoindre la partie'); if(entered !== g.pass){ alert('Mot de passe incorrect'); return; } }
    const nick = prompt('Ton pseudo') || 'Player';
    const payload = { id: g.id, pass: g.pass, nickname: nick };

    // prefer backend host first
    fetch('http://localhost:4000/api/join', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) })
      .then(r => { if(!r.ok) throw new Error('join failed'); return r.json(); })
      .then(() => { window.location.href = `waiting.html?game=${g.id}`; })
      .catch(() => {
        fetch('/api/join', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) })
          .then(r => { if(!r.ok) throw new Error('join failed'); return r.json(); })
          .then(() => { window.location.href = `waiting.html?game=${g.id}`; })
          .catch(() => { saveGame(g); window.location.href = `waiting.html?game=${g.id}`; });
      });

  });

  li.appendChild(btn);
  ul.appendChild(li);
}

q('#leave-btn')?.addEventListener('click', () => showLobby());

q('#flip-btn')?.addEventListener('click', () => { const board = q('#board-container'); board.classList.toggle('flipped'); });

function renderBoard(asWhite=true) {
  const container = q('#board-container');
  if(!container) return;
  container.innerHTML = '';
  const board = document.createElement('div');
  board.className = 'board';
  if (!asWhite) board.classList.add('flipped');

  for (let r = 0; r < 8; r++) {
    const row = document.createElement('div');
    row.className = 'row';
    for (let c = 0; c < 8; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      const piece = document.createElement('img');
      piece.className = 'piece';
      if (r === 1) piece.src = 'assets/chess-pieces/chess_maestro_bw/wP.svg';
      else if (r === 6) piece.src = 'assets/chess-pieces/chess_maestro_bw/bP.svg';
      else piece.style.display = 'none';
      cell.appendChild(piece);
      row.appendChild(cell);
    }
    board.appendChild(row);
  }

  container.appendChild(board);
}

// initial view
showLobby();

// waiting room helpers
let pollInterval = null;
function showWaiting(game){
  q('#lobby').classList.add('hidden');
  q('#board-section')?.classList?.add('hidden');
  q('#lobby-waiting').classList.remove('hidden');
  q('#wait-game-id').textContent = game.id || '';
  renderWaitingPlayers(game.players || []);
}

function renderWaitingPlayers(players){
  const ul = q('#wait-players'); ul.innerHTML = '';
  if(!players || players.length === 0) ul.innerHTML = '<li>Aucun joueur</li>';
  (players||[]).forEach(p => { const li = document.createElement('li'); li.textContent = `${p.nickname} (${p.colorAssigned || p.colorChoice})`; ul.appendChild(li); });
}

function startPolling(gameId){
  if(pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(() => {
    fetch(`/api/game/${gameId}`).then(r => { if(!r.ok) throw new Error('no api'); return r.json(); }).then(g => {
      renderWaitingPlayers(g.players || []);
      if(g.started){ clearInterval(pollInterval); q('#lobby-waiting').classList.add('hidden'); showBoard(g.id, 'white'); }
    }).catch(() => {
      fetch(`http://localhost:4000/api/game/${gameId}`).then(r => r.json()).then(g => { renderWaitingPlayers(g.players || []); if(g.started){ clearInterval(pollInterval); q('#lobby-waiting').classList.add('hidden'); showBoard(g.id, 'white'); } }).catch(()=>{});
    });
  }, 1000);
}

q('#start-btn')?.addEventListener('click', () => {
  const id = q('#wait-game-id').textContent;
  fetch('/api/start', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id }) })
    .then(r => { if(!r.ok) throw new Error('start failed'); return r.json(); })
    .then(() => alert('Partie démarrée'))
    .catch(() => { fetch('http://localhost:4000/api/start', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id }) }).then(()=>alert('Partie démarrée')).catch(()=>alert('Impossible de démarrer la partie')); });
});

q('#back-to-lobby')?.addEventListener('click', () => { if(pollInterval) clearInterval(pollInterval); q('#lobby-waiting').classList.add('hidden'); showLobby(); });
