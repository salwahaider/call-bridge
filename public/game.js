const socket = io();

let state = {
  roomId: null,
  myPosition: null,
  myName: null,
  myHand: [],
  phase: 'landing',
  calls: { N: null, E: null, S: null, W: null },
  callingPlayer: null,
  currentPlayer: null,
  trickCounts: { N: 0, E: 0, S: 0, W: 0 },
  players: [],
  scores: { N: 0, E: 0, S: 0, W: 0 },
  roundNumber: 0,
  targetScore: 250,
  tricksPlayed: 0,
};

const SUIT_SYMBOLS = { S:'♠', H:'♥', D:'♦', C:'♣' };
const POS_FULL     = { N:'North', E:'East', S:'South', W:'West' };
const SUIT_ORDER   = { S:4, H:3, D:2, C:1 };
const RANK_ORDER   = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'T':10,'J':11,'Q':12,'K':13,'A':14 };
const RANK_DISPLAY = { T:'10', J:'J', Q:'Q', K:'K', A:'A' };
const POS_COLOR    = { N:0, E:1, S:2, W:3 };

// Each player always sees themselves at the bottom.
// Counter-clockwise play: N→W→S→E→N
const LAYOUTS = {
  S: { bottom:'S', top:'N', left:'E', right:'W' },
  N: { bottom:'N', top:'S', left:'W', right:'E' },
  E: { bottom:'E', top:'W', left:'N', right:'S' },
  W: { bottom:'W', top:'E', left:'S', right:'N' },
};

function layout()        { return LAYOUTS[state.myPosition] || LAYOUTS['S']; }
function actualPos(slot) { const l=layout(); return l[{south:'bottom',north:'top',west:'left',east:'right'}[slot]]; }

function rankDisplay(r) { return RANK_DISPLAY[r] || r; }
function suitSym(s)     { return SUIT_SYMBOLS[s] || s; }
function isRed(s)       { return s === 'H' || s === 'D'; }
function isSpade(s)     { return s === 'S'; }

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Realistic card HTML with corner indices + center pip
function cardHTML(card, playable=false, onclickStr='') {
  const r = rankDisplay(card.rank);
  const s = suitSym(card.suit);
  const colorClass = isRed(card.suit) ? 'red' : 'black';
  const isFace = ['J','Q','K','A'].includes(card.rank);
  const cls = ['card', colorClass,
    isSpade(card.suit) ? 'trump-card' : '',
    isFace ? 'face-card' : '',
    playable ? 'playable' : '',
  ].filter(Boolean).join(' ');
  return `<div class="${cls}" ${onclickStr ? `onclick="${onclickStr}"` : ''}>
    <div class="card-corner card-tl"><span class="ci-rank">${r}</span><span class="ci-suit">${s}</span></div>
    <span class="card-pip">${s}</span>
    <div class="card-corner card-br"><span class="ci-rank">${r}</span><span class="ci-suit">${s}</span></div>
  </div>`;
}

function cardBack() { return `<div class="card-back"></div>`; }

// ── Screens & Tabs ──
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function switchTab(name) {
  ['score','chat'].forEach(t => {
    document.getElementById(`tab-${t}`).classList.toggle('active', t === name);
    document.getElementById(`tab-btn-${t}`).classList.toggle('active', t === name);
  });
}

// ── Target score picker ──
let selectedTarget = 25;
document.querySelectorAll('.target-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.target-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedTarget = parseInt(btn.dataset.score);
  });
});

// ── Landing ──
document.getElementById('btn-create').onclick = () => {
  const name = document.getElementById('create-name').value.trim();
  if (!name) return showError('Enter your name');
  state.myName = name;
  socket.emit('create-room', { name, targetScore: selectedTarget });
};

document.getElementById('btn-join').onclick = () => {
  const name = document.getElementById('join-name').value.trim();
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  if (!name) return showError('Enter your name');
  if (!code)  return showError('Enter a room code');
  state.myName = name;
  socket.emit('join-room', { roomId: code, name });
};

document.getElementById('create-name').addEventListener('keydown', e => { if (e.key==='Enter') document.getElementById('btn-create').click(); });
document.getElementById('join-code').addEventListener('keydown',   e => { if (e.key==='Enter') document.getElementById('btn-join').click(); });

function showError(msg) {
  const el = document.getElementById('landing-error');
  el.textContent = msg;
  setTimeout(() => { el.textContent=''; }, 3000);
}

// ── Waiting Room ──
let deckTapped = false;
function tapDeck() {
  if (deckTapped) return;
  deckTapped = true;
  const deck = document.getElementById('deck-stack');
  const hint = document.getElementById('deck-hint');
  hint.textContent = 'Shuffling…';

  // Shuffle animation
  deck.classList.add('shuffling');
  setTimeout(() => {
    deck.classList.remove('shuffling');
    deck.classList.add('dealing');
    hint.textContent = 'Dealing cards…';
    setTimeout(() => {
      socket.emit('start-game', { roomId: state.roomId });
    }, 500);
  }, 700);
}

function renderWaiting(room) {
  document.getElementById('waiting-room-code').textContent = room.id;
  document.getElementById('waiting-target').textContent = `First to ${room.targetScore} points wins`;
  document.getElementById('waiting-players').innerHTML = ['N','E','S','W'].map(pos => {
    const p = room.players.find(pl => pl.position === pos);
    const isMe = p && p.position === state.myPosition;
    const colorIdx = POS_COLOR[pos];
    if (p) {
      const initial = p.name[0].toUpperCase();
      return `<div class="seat ${isMe ? 'you' : 'filled'}">
        <div class="seat-avatar avatar-${colorIdx}">${initial}</div>
        <div class="seat-info">
          <div class="seat-pos">${POS_FULL[pos]}</div>
          <div class="seat-name">${escHtml(p.name)}${isMe ? ' \u2605' : ''}</div>
        </div>
      </div>`;
    }
    return `<div class="seat">
      <div class="seat-avatar empty"></div>
      <div class="seat-info">
        <div class="seat-pos">${POS_FULL[pos]}</div>
        <div class="seat-name empty-label">Waiting\u2026</div>
      </div>
    </div>`;
  }).join('');

  const count = room.players.length;
  document.getElementById('waiting-status').textContent = `${count}/4 players joined`;

  const isHost = room.players[0] && room.players[0].position === state.myPosition;
  const deckArea = document.getElementById('deck-area');
  const hint = document.getElementById('deck-hint');

  if (count === 4 && isHost) {
    deckArea.style.display = 'flex';
    deckTapped = false; // reset so host can tap again after each round
    document.getElementById('deck-stack').classList.remove('shuffling','dealing');
    hint.textContent = 'Tap the deck to shuffle & deal!';
  } else if (count === 4 && !isHost) {
    deckArea.style.display = 'flex';
    hint.textContent = 'Waiting for host to deal…';
    document.getElementById('deck-stack').style.cursor = 'default';
  } else {
    deckArea.style.display = 'none';
  }
}

// ── Game Rendering ──
function renderGame(room) {
  state.tricksPlayed = Object.values(room.trickCounts).reduce((a,b)=>a+b,0);

  // Bottom panel
  document.getElementById('game-number').textContent = `${room.roundNumber}`;
  document.getElementById('score-target').textContent = `${room.targetScore} pts`;

  document.getElementById('player-scores').innerHTML = room.players.map(p => {
    const call  = room.calls[p.position];
    const won   = room.trickCounts[p.position] || 0;
    const score = room.scores[p.position] || 0;
    const pct   = Math.max(0, Math.min(100, Math.round(score / (state.targetScore || 25) * 100)));
    const colorIdx  = POS_COLOR[p.position];
    const callInfo  = call !== null ? `bid ${call}, won ${won}` : room.roundNumber === 1 ? `won ${won}` : 'waiting\u2026';
    return `<div class="player-score-row">
      <div class="ps-avatar avatar-${colorIdx}">${p.name[0].toUpperCase()}</div>
      <div class="ps-info">
        <div class="ps-name">${escHtml(p.name)}</div>
        <div class="ps-call">${callInfo}</div>
        <div class="score-progress"><div class="score-progress-fill" style="width:${pct}%"></div></div>
      </div>
      <div class="ps-score">${score}</div>
    </div>`;
  }).join('');

  // Player labels with bid/won badges
  ['south','north','west','east'].forEach(slot => {
    const pos = actualPos(slot);
    const label = document.getElementById(`label-${slot}`);
    const player = room.players.find(p => p.position === pos);
    const name   = player ? escHtml(player.name) : POS_FULL[pos];
    const isMe   = pos === state.myPosition;
    const active = room.currentPlayer === pos || room.callingPlayer === pos;
    const call   = room.calls[pos];
    const won    = room.trickCounts[pos] || 0;
    const badge  = call !== null
      ? `<span class="call-badge ${won>=call?'made':''}">${won}/${call}</span>`
      : '';
    const colorIdx = POS_COLOR[pos];
    const initial  = player ? player.name[0].toUpperCase() : pos;
    const miniAvatar = `<span class="mini-avatar avatar-${colorIdx}">${initial}</span>`;
    label.innerHTML = miniAvatar + (isMe ? '<em class="you-label">You</em>' : name) + badge;
    label.className = 'player-label' + (active ? ' active-turn' : '');
  });

  document.getElementById('your-turn-indicator').style.display =
    room.currentPlayer === state.myPosition && room.phase === 'playing' ? 'block' : 'none';

  renderLiveScores(room);

  if (room.phase === 'playing' || room.phase === 'scoring') {
    const total = state.tricksPlayed;
    const myWon  = room.trickCounts[state.myPosition] || 0;
    const myCall = room.calls[state.myPosition];
    document.getElementById('tricks-count').style.display = 'flex';
    document.getElementById('trick-num').textContent = `Trick ${Math.min(total+1,13)}/13`;
    document.getElementById('my-tricks').textContent = myCall != null ? `You: ${myWon}/${myCall}` : `You: ${myWon}`;
  }

  renderAllHands(room);
  renderTrick(room.currentTrick || []);
  renderCallPopup(room);
}

function renderLiveScores(room) {
  const container = document.getElementById('live-scores');
  if (room.phase !== 'playing' && room.phase !== 'scoring' && room.phase !== 'calling') {
    container.style.display = 'none'; return;
  }
  container.style.display = 'grid';
  while (container.children.length > 3) container.removeChild(container.lastChild);
  // Update "Bid" column header — hide it in round 1 since there are no bids
  container.children[1].textContent = room.roundNumber === 1 ? '' : 'Bid';

  room.players.forEach(p => {
    const call   = room.calls[p.position];
    const won    = room.trickCounts[p.position] || 0;
    const active = room.currentPlayer === p.position;
    const dispScore = room.scores[p.position] || 0;

    const nameEl  = document.createElement('span');
    nameEl.className = 'ls-name' + (active ? ' ls-row-active' : '');
    const shortName = p.name.length > 7 ? p.name.slice(0,6)+'…' : p.name;
    nameEl.textContent = shortName + (p.position === state.myPosition ? ' ★' : '');

    const callEl  = document.createElement('span');
    callEl.className = 'ls-call';
    callEl.textContent = call !== null ? call : '—';

    const wonEl   = document.createElement('span');
    const over    = call !== null && won > call;
    wonEl.className = 'ls-won' + (over ? ' over' : '');
    wonEl.textContent = won;

    container.appendChild(nameEl);
    container.appendChild(callEl);
    container.appendChild(wonEl);
  });
}

function renderAllHands(room) {
  ['south','north','west','east'].forEach(slot => {
    const pos = actualPos(slot);
    const container = document.getElementById(`hand-${slot}`);
    const isMe = pos === state.myPosition;
    const isMyTurn = room.currentPlayer === pos && room.phase === 'playing';

    if (isMe) {
      container.innerHTML = sortCards([...state.myHand])
        .map(c => cardHTML(c, isMyTurn, isMyTurn ? `playCard('${c.rank}','${c.suit}')` : ''))
        .join('');
    } else {
      const remaining = Math.max(0, 13 - state.tricksPlayed);
      container.innerHTML = Array(remaining).fill(cardBack()).join('');
    }
  });
}

function renderTrick(trick) {
  ['south','north','west','east'].forEach(slot => {
    const pos = actualPos(slot);
    const el = document.getElementById(`trick-${slot[0]}`);
    const entry = trick.find(t => t.position === pos);
    el.innerHTML = entry ? cardHTML(entry.card) : '';
  });
}

// ── Trick Toast ──
let toastTimer = null;
function showTrickToast(msg) {
  const toast = document.getElementById('trick-toast');
  toast.textContent = msg;
  toast.classList.remove('show');
  void toast.offsetWidth;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1500);
}

// ── Call Popup ──
let selectedCall = 2;

function renderCallPopup(room) {
  const isMyTurn = room.phase === 'calling' && room.callingPlayer === state.myPosition;
  const bidBtn = document.getElementById('bid-btn');
  if (bidBtn) bidBtn.style.display = isMyTurn ? 'flex' : 'none';
  // Close popup if it's no longer our turn
  if (!isMyTurn) document.getElementById('call-popup').classList.remove('visible');
}

function openBidPopup() {
  const wheel = document.getElementById('wheel-scroll');
  wheel.innerHTML = Array.from({ length: 12 }, (_, i) => i + 2)
    .map(n => `<div class="wheel-item" data-val="${n}">${n}</div>`)
    .join('');

  document.getElementById('call-popup').classList.add('visible');
  selectedCall = 2;
  wheel.scrollTop = 0;
  updateWheelSelection(wheel);
  wheel.onscroll = () => updateWheelSelection(wheel);
}

function updateWheelSelection(wheel) {
  const idx = Math.round(wheel.scrollTop / 56);
  selectedCall = idx + 2;
  wheel.querySelectorAll('.wheel-item').forEach((el, i) => {
    el.classList.toggle('selected', i === idx);
  });
}

function confirmCall() {
  socket.emit('make-call', { roomId: state.roomId, tricks: selectedCall });
  document.getElementById('call-popup').classList.remove('visible');
  const bidBtn = document.getElementById('bid-btn');
  if (bidBtn) bidBtn.style.display = 'none';
}

// ── Card Sorting ──
function sortCards(hand) {
  return hand.sort((a, b) => {
    if (SUIT_ORDER[a.suit] !== SUIT_ORDER[b.suit]) return SUIT_ORDER[b.suit] - SUIT_ORDER[a.suit];
    return RANK_ORDER[b.rank] - RANK_ORDER[a.rank];
  });
}

function sortHand(by) {
  state.myHand = by === 'suit'
    ? sortCards([...state.myHand])
    : [...state.myHand].sort((a,b) => RANK_ORDER[b.rank] - RANK_ORDER[a.rank]);
  const isMyTurn = state.currentPlayer === state.myPosition && state.phase === 'playing';
  document.getElementById('hand-south').innerHTML = state.myHand
    .map(c => cardHTML(c, isMyTurn, isMyTurn ? `playCard('${c.rank}','${c.suit}')` : ''))
    .join('');
}

// ── Actions ──
function playCard(rank, suit) {
  socket.emit('play-card', { roomId: state.roomId, card: { rank, suit } });
}

function sendChat() {
  const input = document.getElementById('chat-input');
  const msg = input.value.trim();
  if (!msg) return;
  socket.emit('chat', { roomId: state.roomId, message: msg });
  input.value = '';
}

document.getElementById('chat-input').addEventListener('keydown', e => { if (e.key==='Enter') sendChat(); });

function addChatMsg(data, system=false) {
  const box = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'chat-msg' + (system ? ' system' : '');
  if (system) {
    div.textContent = data;
  } else {
    div.innerHTML = `<span class="chat-pos">[${data.position}]</span> <span class="chat-name">${escHtml(data.name)}:</span> <span class="chat-text">${escHtml(data.message)}</span>`;
  }
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

// ── Result Overlay ──
function showResultOverlay(data) {
  const { calls, trickCounts, scoreDeltas, scores, roundNumber, gameOver, winners, hands } = data;
  const firstRound = roundNumber === 1;

  const rows = state.players.map(p => {
    const pos   = p.position;
    const call  = calls[pos];
    const won   = trickCounts[pos];
    const delta = scoreDeltas[pos];
    let dispDelta;
    if (call === null) {
      dispDelta = `Won ${won} tricks <span style="color:rgba(255,255,255,0.4)">(no score — round 1)</span>`;
    } else {
      const diff = won - call;
      const reason = diff >= 2 ? '2+ over bid' : diff < 0 ? 'under bid' : 'made it';
      dispDelta = delta > 0
        ? `Called ${call}, won ${won} → <span class="delta-pos">+${delta}</span>`
        : `Called ${call}, won ${won} (${reason}) → <span class="delta-neg">${delta}</span>`;
    }
    return `<div class="row"><span>${escHtml(p.name)}</span><span>${dispDelta}</span></div>`;
  }).join('');

  const totalRows = state.players
    .slice()
    .sort((a,b) => (scores[b.position]||0) - (scores[a.position]||0))
    .map(p => {
      const sc = scores[p.position] || 0;
      const pct = Math.min(100, Math.round(sc / state.targetScore * 100));
      return `<div class="row">
        <span>${escHtml(p.name)}</span>
        <span>${sc} <span style="color:rgba(255,255,255,0.35);font-size:0.7rem;">(${pct}%)</span></span>
      </div>`;
    }).join('');

  let handsHtml = '';
  if (hands) {
    handsHtml = `<div class="all-hands"><strong>All hands:</strong><br>` +
      ['N','E','S','W'].map(pos => {
        const h = sortCards([...hands[pos]]);
        return `<strong>${POS_FULL[pos]}:</strong> ` +
          ['S','H','D','C'].map(s => {
            const cs = h.filter(c => c.suit===s);
            return cs.length ? suitSym(s)+cs.map(c=>rankDisplay(c.rank)).join('') : '';
          }).filter(Boolean).join(' ');
      }).join('<br>') + `</div>`;
  }

  const winnerSection = gameOver
    ? `<div style="background:rgba(46,204,113,0.15);border:1px solid rgba(46,204,113,0.3);border-radius:10px;padding:12px;color:#2ecc71;font-size:1rem;">
        🏆 ${winners.join(' & ')} win${winners.length>1?'':'s'} the game!
       </div>` : '';

  const nextBtnLabel = gameOver ? 'Play Again' : 'Next Round';

  document.getElementById('overlay-box').innerHTML = `
    <h2>${gameOver ? 'Game Over!' : firstRound ? 'Round 1 Done!' : `Round ${roundNumber} Done!`}</h2>
    ${firstRound ? '<p>No scoring in round 1</p>' : ''}
    ${winnerSection}
    <div class="score-table">${rows}</div>
    <div class="score-table">
      <div class="row" style="color:rgba(255,255,255,0.4);font-size:0.72rem;"><span>Running Totals (target: ${state.targetScore})</span></div>
      ${totalRows}
    </div>
    ${handsHtml}
    <div class="overlay-btns">
      <button class="btn btn-primary" onclick="requestNewGame()">${nextBtnLabel}</button>
      <button class="btn btn-secondary" onclick="closeOverlay()">Close</button>
    </div>
  `;
  document.getElementById('overlay').classList.add('visible');
}

function closeOverlay() { document.getElementById('overlay').classList.remove('visible'); }
function requestNewGame() {
  socket.emit('new-game', { roomId: state.roomId });
  closeOverlay();
  // Return to waiting screen so host can tap deck again
  showScreen('screen-waiting');
}

// ── Socket Events ──
socket.on('room-created', ({ roomId }) => { state.roomId = roomId; showScreen('screen-waiting'); });

socket.on('joined', ({ roomId, position }) => {
  state.roomId     = roomId;
  state.myPosition = position;
  showScreen('screen-waiting');
});

socket.on('room-update', (room) => {
  state.phase         = room.phase;
  state.scores        = room.scores;
  state.roundNumber   = room.roundNumber;
  state.targetScore   = room.targetScore;
  state.currentPlayer = room.currentPlayer;
  state.callingPlayer = room.callingPlayer;
  state.players       = room.players;
  state.calls         = room.calls || { N:null,E:null,S:null,W:null };
  state.trickCounts   = room.trickCounts || { N:0,E:0,S:0,W:0 };

  if (room.phase === 'waiting') { renderWaiting(room); showScreen('screen-waiting'); }
  else { renderGame(room); showScreen('screen-game'); }
});

socket.on('game-started', ({ hand, dealer, roundNumber, targetScore }) => {
  state.myHand      = hand;
  state.roundNumber = roundNumber;
  state.targetScore = targetScore;
  state.trickCounts = { N:0,E:0,S:0,W:0 };
  state.calls       = { N:null,E:null,S:null,W:null };
  state.tricksPlayed = 0;

  ['n','e','s','w'].forEach(p => document.getElementById(`trick-${p}`).innerHTML='');
  document.getElementById('tricks-count').style.display = 'none';
  document.getElementById('your-turn-indicator').style.display = 'none';

  addChatMsg(roundNumber === 1
    ? `Round 1! ♠ Spades trump — no bidding this round, just play!`
    : `Round ${roundNumber}! ♠ Spades trump — place your bids!`, true);
});

socket.on('bids-reset', ({ message }) => {
  state.calls = { N:null,E:null,S:null,W:null };
  addChatMsg(`⚠ ${message}`, true);
});

socket.on('call-made', ({ position, tricks }) => {
  state.calls[position] = tricks;
  const player = state.players.find(p => p.position === position);
  addChatMsg(`${player ? player.name : POS_FULL[position]} bids ${tricks}`, true);
});

socket.on('calling-complete', ({ calls }) => {
  state.calls = calls;
  const summary = state.players.map(p => `${p.name.split(' ')[0]}:${calls[p.position]}`).join('  ');
  addChatMsg(`Bids in! ${summary} — Let's play!`, true);
});

socket.on('card-played', ({ position, card }) => {
  if (position === state.myPosition) {
    const i = state.myHand.findIndex(c => c.rank===card.rank && c.suit===card.suit);
    if (i !== -1) state.myHand.splice(i, 1);
  }
});

socket.on('trick-complete', ({ winner, trickCounts }) => {
  state.trickCounts  = trickCounts;
  state.tricksPlayed = Object.values(trickCounts).reduce((a,b)=>a+b,0);
  const player = state.players.find(p => p.position === winner);
  const name   = player ? player.name : POS_FULL[winner];
  const call   = state.calls[winner];
  const won    = trickCounts[winner];
  const isMe   = winner === state.myPosition;
  showTrickToast(isMe ? `You win! (${won}${call!=null?'/'+call:''})` : `${name.split(' ')[0]} wins!`);
  addChatMsg(`${name} wins trick ${state.tricksPlayed}`, true);
  setTimeout(() => ['n','e','s','w'].forEach(p => document.getElementById(`trick-${p}`).innerHTML=''), 1100);
});

socket.on('game-over',   data => { state.phase='scoring'; setTimeout(()=>showResultOverlay(data),800); });
socket.on('player-left', ({ name }) => addChatMsg(`${name} left.`, true));
socket.on('chat',  msg  => addChatMsg(msg));
socket.on('error', ({ message }) => {
  if (!state.roomId) showError(message);
  else addChatMsg(`⚠ ${message}`, true);
});
