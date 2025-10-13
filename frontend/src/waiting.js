const q = s => document.querySelector(s);

function qsParam(name){
  const p = new URLSearchParams(window.location.search);
  return p.get(name);
}

const gameId = qsParam('game');
if(!gameId){ document.body.innerHTML = '<p>Game ID missing in URL</p>'; }
else {
  q('#wait-game-id').textContent = gameId;
  // try backend first, if fails read from localStorage (fallback created locally)
  fetch(`/api/game/${gameId}`).then(r => { if(!r.ok) throw new Error('no api'); return r.json(); }).then(g => {
    renderWaitingPlayers(g.players||[]);
    if(!g.started) startPolling(gameId);
  }).catch(()=>{
    // fallback: look in localStorage
    const all = JSON.parse(localStorage.getItem('games') || '[]');
    const g = all.find(x=>x.id === gameId);
    if(g){ renderWaitingPlayers(g.players || []); } else { startPolling(gameId); }
  });
}

function renderWaitingPlayers(players){
  const ul = q('#wait-players'); ul.innerHTML = '';
  if(!players || players.length === 0) ul.innerHTML = '<li>Aucun joueur</li>';
  (players||[]).forEach(p => { const li = document.createElement('li'); li.textContent = `${p.nickname} (${p.colorAssigned || p.colorChoice})`; ul.appendChild(li); });
}

let poll = null;
function startPolling(id){
  if(poll) clearInterval(poll);
  poll = setInterval(()=>{
    fetch(`/api/game/${id}`).then(r=>{ if(!r.ok) throw new Error('no api'); return r.json(); }).then(g=>{ renderWaitingPlayers(g.players||[]); if(g.started){ clearInterval(poll); window.location.href = `index.html?game=${g.id}`; } }).catch(()=>{
      fetch(`http://localhost:4000/api/game/${id}`).then(r=>r.json()).then(g=>{ renderWaitingPlayers(g.players||[]); if(g.started){ clearInterval(poll); window.location.href = `index.html?game=${g.id}`; } }).catch(()=>{});
    });
  }, 1000);
}

q('#join-btn')?.addEventListener('click', () => {
  const nick = q('#nick-input').value || 'Guest';
  const colorChoice = q('#color-choice').value || 'random';
  fetch('/api/join', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id: gameId, nickname: nick, colorChoice }) })
    .then(r=>{ if(!r.ok) throw new Error('join failed'); return r.json(); }).then(resp=>{ renderWaitingPlayers(resp.game.players || []); }).catch(()=>{ alert('Impossible de rejoindre (backend absent)'); });
});

q('#start-btn')?.addEventListener('click', () => {
  fetch('/api/start', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id: gameId }) })
    .then(r=>{ if(!r.ok) throw new Error('start failed'); return r.json(); }).then(()=>{ alert('Partie démarrée'); }).catch(()=>{ alert('Impossible de démarrer'); });
});
