const q = s => document.querySelector(s);

function qsParam(name){
  const p = new URLSearchParams(window.location.search);
  return p.get(name);
}

const gameId = qsParam('game');
console.log('[waiting.js] loaded - build: v2 -', { gameId, url: window.location.href });
if(!gameId){ document.body.innerHTML = '<p>Game ID missing in URL</p>'; }
else {
  // Query explicit backend first to avoid interpreting same-origin static 404 as game-deleted
  fetch(`http://localhost:4000/api/game/${gameId}`).then(r => {
    if(r.status === 404){
      // game deleted — eject user to lobby and clear session state
      sessionStorage.removeItem(`playerId:${gameId}`);
      alert('La partie a été supprimée par l\'hôte. Retour au lobby.');
      window.location.href = 'index.html';
      throw new Error('game deleted');
    }
    if(!r.ok) throw new Error('no api');
    return r.json();
  }).then(g => {
    q('#wait-game-id').textContent = g.name || '';
    renderWaitingPlayers(g.players||[]);
    // if game already started, redirect immediately to the game page
    if (g.started) { window.location.href = `game.html?game=${g.id}`; return; }
    // display current player nick and color if we have a playerId
    const stored = sessionStorage.getItem(`playerId:${gameId}`);
    if(stored){
      const me = (g.players||[]).find(p=>p.id===stored);
      if(me){ q('#player-nick').textContent = 'Vous'; q('#player-color').textContent = me.colorChoice || '-'; }
    }
    // owner-only start button
    const ownerId = g.players && g.players[0] && g.players[0].id;
    if(ownerId && stored && ownerId === stored){ q('#start-btn')?.classList.remove('hidden'); } else { q('#start-btn')?.classList.add('hidden'); }
      // disable start button unless there are at least 2 players
      const startBtn = q('#start-btn');
      if(startBtn){ if((g.players||[]).length < 2){ startBtn.disabled = true; } else { startBtn.disabled = false; } }
  if(!g.started) startPolling(gameId);
    // try to connect socket.io for instant updates and identification
    tryConnectSocket(gameId);
  }).catch(()=>{
    // fallback: attempt same-origin server, then localStorage
    fetch(`/api/game/${gameId}`).then(r=>{
      if(r.status === 404){ sessionStorage.removeItem(`playerId:${gameId}`); alert('La partie a été supprimée par l\'hôte. Retour au lobby.'); window.location.href = 'index.html'; throw new Error('game deleted'); }
      if(!r.ok) throw new Error('no api');
      return r.json();
    }).then(g=>{
      q('#wait-game-id').textContent = g.name || '';
      renderWaitingPlayers(g.players||[]);
      // if game already started, redirect immediately to the game page
      if (g.started) { window.location.href = `game.html?game=${g.id}`; return; }
      const stored = sessionStorage.getItem(`playerId:${gameId}`);
      if(stored){ const me = (g.players||[]).find(p=>p.id===stored); if(me){ q('#player-nick').textContent = 'Vous'; q('#player-color').textContent = me.colorChoice || '-'; } }
      const ownerId = g.players && g.players[0] && g.players[0].id;
      if(ownerId && stored && ownerId === stored){ q('#start-btn')?.classList.remove('hidden'); } else { q('#start-btn')?.classList.add('hidden'); }
        // disable start button unless there are at least 2 players
        const startBtn = q('#start-btn');
        if(startBtn){ if((g.players||[]).length < 2){ startBtn.disabled = true; } else { startBtn.disabled = false; } }
      if(!g.started) startPolling(gameId);
      tryConnectSocket(gameId);
    }).catch(()=>{
      const all = JSON.parse(localStorage.getItem('games') || '[]');
      const g = all.find(x=>x.id === gameId);
      if(g){ q('#wait-game-id').textContent = g.name || ''; renderWaitingPlayers(g.players || []); } else { startPolling(gameId); }
    });
  });
}

// Socket.IO wiring: connect to backend explicitly and join game room; send identify so server can map socket->player
function tryConnectSocket(gameId){
  if(typeof io === 'undefined') return; // socket lib not loaded
  // connect explicitly to backend to avoid same-origin static server 404
  const sock = io('http://localhost:4000', { transports: ['websocket', 'polling'] });
  sock.on('connect', () => {
    console.log('socket connected from waiting page', sock.id);
    sock.emit('join-game', gameId);
    const stored = sessionStorage.getItem(`playerId:${gameId}`) || (()=>{ const all = JSON.parse(localStorage.getItem('games') || '[]'); const g = all.find(x=>x.id===gameId); return g && g.players && g.players[0] && g.players[0].id; })();
    if(stored) sock.emit('identify', { gameId, playerId: stored });
  });
  sock.on('game-deleted', (payload) => {
    if(payload && payload.gameId === gameId){
      sessionStorage.removeItem(`playerId:${gameId}`);
      alert('La partie a été supprimée par l\'hôte. Retour au lobby.');
      window.location.href = 'index.html';
    }
  });
  sock.on('player-update', (g) => {
    if(!g) return;
    renderWaitingPlayers(g.players||[]);
  });
  sock.on('game-start', (g) => {
    if(!g) return;
    // redirect to game view when started
    window.location.href = `game.html?game=${g.id}`;
  });
  sock.on('connect_error', (err) => {
    console.warn('socket connect error', err);
    // leave polling as fallback
  });
}

function renderWaitingPlayers(players){
  const ul = q('#wait-players'); ul.innerHTML = '';
  if(!players || players.length === 0) ul.innerHTML = '<li>Aucun joueur</li>';
  (players||[]).forEach((p, i) => { const li = document.createElement('li'); li.textContent = `Joueur ${i+1} (${p.colorAssigned || p.colorChoice})`; ul.appendChild(li); });
}

let poll = null;
function startPolling(id){
  if(poll) clearInterval(poll);
  poll = setInterval(()=>{
    // Prefer explicit backend host to avoid same-origin 404 from static server
    fetch(`http://localhost:4000/api/game/${id}`).then(r=>{ if(!r.ok) throw new Error('no api'); return r.json(); }).then(g=>{ renderWaitingPlayers(g.players||[]); if(g.started){ clearInterval(poll); window.location.href = `game.html?game=${g.id}`; } }).catch(()=>{
      // fallback to same-origin if backend not reachable
      fetch(`/api/game/${id}`).then(r=>{ if(!r.ok) throw new Error('no api'); return r.json(); }).then(g=>{ renderWaitingPlayers(g.players||[]); if(g.started){ clearInterval(poll); window.location.href = `game.html?game=${g.id}`; } }).catch(()=>{});
    });
  }, 1000);
}

// Join handled from lobby; waiting room doesn't provide a join button

q('#start-btn')?.addEventListener('click', () => {
  // force explicit backend host (no fallback) so request always goes to :4000
  console.log('[waiting] start click - POST to http://localhost:4000/api/start', { gameId });
  fetch('http://localhost:4000/api/start', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id: gameId }) })
    .then(async (r) => {
      const body = await r.json().catch(()=>({}));
      if(!r.ok) throw body;
      return body;
    })
    .then((resp)=>{ try { window.location.href = `game.html?game=${resp.game.id}`; } catch(e) { alert('Partie démarrée'); } })
    .catch((err)=>{ const msg = (err && err.error) ? err.error : (typeof err === 'string' ? err : JSON.stringify(err)); alert('Impossible de démarrer: ' + msg); console.error('start error', err); });
});

q('#leave-btn')?.addEventListener('click', () => {
  const stored = sessionStorage.getItem(`playerId:${gameId}`) || null;
  const playerId = stored || (() => { const all = JSON.parse(localStorage.getItem('games') || '[]'); const g = all.find(x=>x.id===gameId); return g && g.players && g.players[0] && g.players[0].id; })();
  if(!playerId){ alert('Impossible de déterminer votre identifiant de joueur pour quitter'); return; }
  // prefer explicit backend host to avoid same-origin static server 404s
  fetch(`http://localhost:4000/api/leave`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ gameId, playerId }) })
    .then(r=>{ if(!r.ok) throw new Error('leave failed'); return r.json(); }).then(resp=>{
      if(resp.deleted){ alert('Vous étiez l\'hôte — la partie a été supprimée'); window.location.href = 'index.html'; }
      else { alert('Vous avez quitté la partie'); window.location.href = 'index.html'; }
    }).catch(()=>{
      // fallback to same-origin in case backend is proxied
      fetch('/api/leave', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ gameId, playerId }) })
        .then(r=>{ if(!r.ok) throw new Error('leave failed'); return r.json(); }).then(resp=>{
          if(resp.deleted){ alert('Vous étiez l\'hôte — la partie a été supprimée'); window.location.href = 'index.html'; }
          else { alert('Vous avez quitté la partie'); window.location.href = 'index.html'; }
        }).catch(err=>{
          console.error('leave failed', err);
          alert('Impossible de quitter la partie — le serveur est injoignable. Si le problème persiste, vérifiez que le backend tourne sur :4000.');
        });
    });
});
