const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
const SUITS     = ['C', 'D', 'H', 'S'];
const RANKS     = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
// Counter-clockwise order: N → W → S → E → N
const POSITIONS = ['N', 'W', 'S', 'E'];
const RANK_ORDER = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'T':10,'J':11,'Q':12,'K':13,'A':14 };
const TRUMP = 'S'; // Spades are ALWAYS trump

function createDeck() {
  const deck = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push({ suit, rank });
  return deck;
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function deal(deck) {
  const hands = { N: [], E: [], S: [], W: [] };
  deck.forEach((card, i) => {
    hands[POSITIONS[i % 4]].push(card);
  });
  return hands;
}

// Each player must have at least one card of every suit
function handsSatisfyRule(hands) {
  const suits = ['C','D','H','S'];
  return ['N','E','S','W'].every(pos =>
    suits.every(s => hands[pos].some(c => c.suit === s))
  );
}

function dealUntilValid() {
  let hands, attempts = 0;
  do {
    hands = deal(shuffle(createDeck()));
    attempts++;
  } while (!handsSatisfyRule(hands) && attempts < 1000);
  return hands;
}

// Counter-clockwise next position
function nextCCW(pos) {
  return POSITIONS[(POSITIONS.indexOf(pos) + 1) % 4];
}

// Previous in CCW = clockwise next
function prevCCW(pos) {
  return POSITIONS[(POSITIONS.indexOf(pos) + 3) % 4];
}

// Who wins the trick (Spades always trump)
function whoWinsTrick(trick) {
  let best = trick[0];
  for (let i = 1; i < trick.length; i++) {
    const c = trick[i].card, b = best.card;
    if (c.suit === TRUMP && b.suit !== TRUMP) {
      best = trick[i]; // spade beats non-spade
    } else if (c.suit === TRUMP && b.suit === TRUMP && RANK_ORDER[c.rank] > RANK_ORDER[b.rank]) {
      best = trick[i]; // higher spade wins
    } else if (c.suit === b.suit && b.suit !== TRUMP && RANK_ORDER[c.rank] > RANK_ORDER[b.rank]) {
      best = trick[i]; // higher card of led suit
    }
  }
  return best.position;
}

// Validate a played card under Call Bridge rules:
// 1. Must follow led suit if possible
// 2. If can't follow suit, must play a spade HIGHER than any spade already in the trick (if possible)
// 3. If none of the above, play any card
function isValidPlay(hand, card, trick) {
  if (trick.length === 0) return true; // leading: any card valid

  const ledSuit = trick[0].card.suit;
  const hasSuit = hand.some(c => c.suit === ledSuit);

  if (hasSuit) {
    return card.suit === ledSuit; // must follow suit
  }

  // Can't follow suit — check spade rule
  const spadesInTrick = trick.filter(t => t.card.suit === TRUMP);
  const highestSpadeInTrick = spadesInTrick.length > 0
    ? Math.max(...spadesInTrick.map(t => RANK_ORDER[t.card.rank]))
    : 0;

  const higherSpades = hand.filter(c => c.suit === TRUMP && RANK_ORDER[c.rank] > highestSpadeInTrick);
  const anySpades    = hand.filter(c => c.suit === TRUMP);

  if (higherSpades.length > 0) {
    // Must play a spade higher than current highest spade
    return card.suit === TRUMP && RANK_ORDER[card.rank] > highestSpadeInTrick;
  }

  if (anySpades.length > 0 && spadesInTrick.length === 0) {
    // Has spades but none higher; if no spade in trick yet, should play a spade
    // (in many variants you still must trump even if can't overtrump)
    return card.suit === TRUMP;
  }

  // No valid spades to play or already a winning spade in trick — any card
  return true;
}

// Scoring:
//   Exact or +1 over call  → +call points
//   2 or more over call    → -call points (overbid penalty)
//   Under call             → -call points
function calculateScore(call, won) {
  const diff = won - call;
  if (diff >= 0 && diff <= 1) return call;   // made it (exact or 1 over) → +call
  return -call;                               // under OR 2+ over → -call
}

function createRoom(roomId, targetScore) {
  return {
    id: roomId,
    players: {},
    positions: { N: null, E: null, S: null, W: null },
    phase: 'waiting',
    targetScore: targetScore || 250,
    dealer: null,
    hands: null,
    calls: { N: null, E: null, S: null, W: null },
    callingPlayer: null,
    currentTrick: [],
    tricks: [],
    trickCounts: { N: 0, E: 0, S: 0, W: 0 },
    currentPlayer: null,
    // Scores stored as integers (actual_score * 10 to handle 0.1 overtricks)
    scores: { N: 0, E: 0, S: 0, W: 0 },
    roundNumber: 0,
    gameOver: false,
  };
}

function getRoomState(room) {
  return {
    id: room.id,
    phase: room.phase,
    targetScore: room.targetScore,
    players: Object.values(room.players).map(p => ({ name: p.name, position: p.position })),
    positions: room.positions,
    dealer: room.dealer,
    calls: room.calls,
    callingPlayer: room.callingPlayer,
    currentTrick: room.currentTrick,
    trickCounts: room.trickCounts,
    currentPlayer: room.currentPlayer,
    scores: room.scores,
    roundNumber: room.roundNumber,
    gameOver: room.gameOver,
  };
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('create-room', ({ name, targetScore }) => {
    const roomId = Math.random().toString(36).substr(2, 6).toUpperCase();
    rooms[roomId] = createRoom(roomId, targetScore || 250);
    joinRoom(socket, roomId, name);
    socket.emit('room-created', { roomId });
  });

  socket.on('join-room', ({ roomId, name }) => {
    const room = rooms[roomId.toUpperCase()];
    if (!room) return socket.emit('error', { message: 'Room not found' });
    if (Object.keys(room.players).length >= 4) return socket.emit('error', { message: 'Room is full' });
    if (room.phase !== 'waiting') return socket.emit('error', { message: 'Game already in progress' });
    joinRoom(socket, roomId.toUpperCase(), name);
  });

  socket.on('start-game', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    if (Object.keys(room.players).length !== 4)
      return socket.emit('error', { message: 'Need 4 players to start' });
    startGame(room);
  });

  socket.on('make-call', ({ roomId, tricks }) => {
    const room = rooms[roomId];
    if (!room || room.phase !== 'calling') return;
    const player = room.players[socket.id];
    if (!player || player.position !== room.callingPlayer) return;
    const n = parseInt(tricks);
    if (isNaN(n) || n < 2 || n > 13) return socket.emit('error', { message: 'Minimum call is 2' });
    processCall(room, player.position, n);
  });

  socket.on('play-card', ({ roomId, card }) => {
    const room = rooms[roomId];
    if (!room || room.phase !== 'playing') return;
    const player = room.players[socket.id];
    if (!player || player.position !== room.currentPlayer) return;
    processPlayCard(room, player.position, card);
  });

  socket.on('new-game', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.phase !== 'scoring') return;
    if (room.gameOver) {
      room.scores = { N: 0, E: 0, S: 0, W: 0 };
      room.roundNumber = 0;
      room.gameOver = false;
    }
    // Return to waiting so host can tap the deck
    room.phase = 'waiting';
    io.to(roomId).emit('room-update', getRoomState(room));
  });

  socket.on('chat', ({ roomId, message }) => {
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    io.to(roomId).emit('chat', { name: player.name, position: player.position, message });
  });

  socket.on('disconnect', () => {
    for (const roomId in rooms) {
      const room = rooms[roomId];
      if (room.players[socket.id]) {
        const player = room.players[socket.id];
        room.positions[player.position] = null;
        delete room.players[socket.id];
        io.to(roomId).emit('player-left', { name: player.name, position: player.position });
        io.to(roomId).emit('room-update', getRoomState(room));
        if (Object.keys(room.players).length === 0) delete rooms[roomId];
        break;
      }
    }
  });
});

function joinRoom(socket, roomId, name) {
  const room = rooms[roomId];
  const allPos = ['N', 'E', 'S', 'W'];
  const available = allPos.filter(p => !room.positions[p]);
  const position = available[0];
  room.positions[position] = socket.id;
  room.players[socket.id] = { id: socket.id, name, position };
  socket.join(roomId);
  socket.emit('joined', { roomId, position, name });
  io.to(roomId).emit('room-update', getRoomState(room));
}

function startGame(room) {
  const deck = shuffle(createDeck());
  room.hands = dealUntilValid();
  room.roundNumber++;

  // Rotate dealer clockwise each round (among NSEW)
  const dealerPositions = ['N', 'E', 'S', 'W'];
  room.dealer = dealerPositions[(room.roundNumber - 1) % 4];

  room.calls = { N: null, E: null, S: null, W: null };
  room.currentTrick = [];
  room.tricks = [];
  room.trickCounts = { N: 0, E: 0, S: 0, W: 0 };

  // Calling starts from dealer's right (one step back in CCW), goes CCW
  const firstLeader = prevCCW(room.dealer);

  if (room.roundNumber === 1) {
    // No bidding in first round — go straight to playing
    room.phase = 'playing';
    room.callingPlayer = null;
    room.currentPlayer = firstLeader;
  } else {
    room.phase = 'calling';
    room.callingPlayer = firstLeader;
    room.currentPlayer = firstLeader;
  }

  for (const [socketId, player] of Object.entries(room.players)) {
    io.to(socketId).emit('game-started', {
      hand: room.hands[player.position],
      dealer: room.dealer,
      roundNumber: room.roundNumber,
      targetScore: room.targetScore,
    });
  }

  io.to(room.id).emit('room-update', getRoomState(room));
}

function processCall(room, position, tricks) {
  room.calls[position] = tricks;
  io.to(room.id).emit('call-made', { position, tricks });

  const allCalled = ['N','E','S','W'].every(p => room.calls[p] !== null);
  if (allCalled) {
    const totalBids = Object.values(room.calls).reduce((a,b) => a+b, 0);
    if (totalBids < 11) {
      // Reset all calls and start over — notify players
      room.calls = { N: null, E: null, S: null, W: null };
      room.callingPlayer = prevCCW(room.dealer); // restart from beginning
      io.to(room.id).emit('bids-reset', {
        message: `Total bids were ${totalBids} — minimum is 11. Please re-bid!`
      });
    } else {
      room.phase = 'playing';
      room.callingPlayer = null;
      room.currentPlayer = prevCCW(room.dealer); // dealer's right leads first trick
      io.to(room.id).emit('calling-complete', { calls: room.calls });
    }
  } else {
    room.callingPlayer = nextCCW(position);
  }

  io.to(room.id).emit('room-update', getRoomState(room));
}

function processPlayCard(room, position, card) {
  const hand = room.hands[position];
  const idx = hand.findIndex(c => c.rank === card.rank && c.suit === card.suit);
  if (idx === -1) return;

  if (!isValidPlay(hand, card, room.currentTrick)) {
    const sock = room.players[Object.keys(room.players).find(id => room.players[id].position === position)];
    if (sock) io.to(sock.id).emit('error', { message: 'Invalid play — check suit rules' });
    return;
  }

  hand.splice(idx, 1);
  room.currentTrick.push({ position, card });
  io.to(room.id).emit('card-played', { position, card });

  if (room.currentTrick.length === 4) {
    const winner = whoWinsTrick(room.currentTrick);
    room.trickCounts[winner]++;
    room.tricks.push({ cards: [...room.currentTrick], winner });
    room.currentTrick = [];
    room.currentPlayer = winner; // winner leads next trick

    io.to(room.id).emit('trick-complete', { winner, trickCounts: room.trickCounts });

    const totalTricks = Object.values(room.trickCounts).reduce((a, b) => a + b, 0);
    if (totalTricks === 13) {
      endGame(room);
      return;
    }
  } else {
    room.currentPlayer = nextCCW(position); // play goes counter-clockwise
  }

  io.to(room.id).emit('room-update', getRoomState(room));
}

function endGame(room) {
  const { calls, trickCounts, roundNumber } = room;
  const scoreDeltas = {};

  ['N','E','S','W'].forEach(pos => {
    // Round 1 has no calls — no score awarded
    scoreDeltas[pos] = calls[pos] !== null ? calculateScore(calls[pos], trickCounts[pos]) : 0;
    room.scores[pos] += scoreDeltas[pos];
  });

  const winners = ['N','E','S','W'].filter(p => room.scores[p] >= room.targetScore);
  room.gameOver = winners.length > 0;

  room.phase = 'scoring';

  io.to(room.id).emit('game-over', {
    calls,
    trickCounts,
    scoreDeltas,
    scores: room.scores,
    roundNumber,
    gameOver: room.gameOver,
    winners: winners.map(p => {
      const player = Object.values(room.players).find(pl => pl.position === p);
      return player ? player.name : p;
    }),
    hands: room.hands,
  });
  io.to(room.id).emit('room-update', getRoomState(room));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Call Bridge server running at http://localhost:${PORT}`));
