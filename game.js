// Ludo game rules engine (pure logic, no dependencies).
// Token position per player: -1 = in yard, 0..50 = on track (relative to
// player's start), 51..55 = home column, 56 = finished.

const TRACK = 52;
const START = [0, 13, 26, 39];            // absolute start cell per seat
const SAFE_ABS = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
const FINISH = 56;

function createGame(seats) {
  // seats: array of seat indexes (0..3) that are playing, e.g. [0, 2]
  return {
    players: seats.map(s => ({ seat: s, tokens: [-1, -1, -1, -1], done: false })),
    turn: 0,
    dice: null,
    rolled: false,
    sixes: 0,
    winners: [],
    log: [],
  };
}

const absPos = (player, rel) => (START[player.seat] + rel) % TRACK;

function legalMoves(state) {
  const p = state.players[state.turn];
  const d = state.dice;
  const moves = [];
  p.tokens.forEach((pos, i) => {
    if (pos === FINISH) return;
    if (pos === -1) { if (d === 6) moves.push(i); return; }
    if (pos + d <= FINISH) moves.push(i);
  });
  return moves;
}

function nextTurn(state) {
  state.sixes = 0;
  state.dice = null;
  state.rolled = false;
  const n = state.players.length;
  for (let k = 1; k <= n; k++) {
    const idx = (state.turn + k) % n;
    if (!state.players[idx].done) { state.turn = idx; return; }
  }
}

// forced: optional number 1..6 chosen by the server (admin override)
function rollDice(state, forced) {
  if (state.rolled || state.winners.length >= state.players.length - 1) {
    return { ok: false, error: 'cannot roll now' };
  }
  const d = forced >= 1 && forced <= 6 ? forced : 1 + Math.floor(Math.random() * 6);
  state.dice = d;
  state.rolled = true;
  state.sixes = d === 6 ? state.sixes + 1 : 0;

  if (state.sixes === 3) {             // three sixes in a row: turn lost
    nextTurn(state);
    return { ok: true, dice: d, moves: [], passed: true, reason: 'three sixes' };
  }
  const moves = legalMoves(state);
  if (moves.length === 0) {
    nextTurn(state);
    return { ok: true, dice: d, moves: [], passed: true, reason: 'no move' };
  }
  return { ok: true, dice: d, moves, passed: false };
}

function moveToken(state, tokenIdx) {
  if (!state.rolled) return { ok: false, error: 'roll first' };
  if (!legalMoves(state).includes(tokenIdx)) return { ok: false, error: 'illegal move' };

  const p = state.players[state.turn];
  const d = state.dice;
  let extra = d === 6;
  let captured = null;

  p.tokens[tokenIdx] = p.tokens[tokenIdx] === -1 ? 0 : p.tokens[tokenIdx] + d;
  const pos = p.tokens[tokenIdx];

  if (pos === FINISH) extra = true;

  // capture check (only on shared track, non-safe cells)
  if (pos <= 50) {
    const a = absPos(p, pos);
    if (!SAFE_ABS.has(a)) {
      state.players.forEach((q, qi) => {
        if (qi === state.turn) return;
        q.tokens.forEach((qp, ti) => {
          if (qp >= 0 && qp <= 50 && absPos(q, qp) === a) {
            q.tokens[ti] = -1;
            captured = { player: qi, token: ti };
            extra = true;
          }
        });
      });
    }
  }

  if (p.tokens.every(t => t === FINISH)) {
    p.done = true;
    state.winners.push(state.turn);
    extra = false;
  }

  const result = { ok: true, token: tokenIdx, to: pos, captured, extraTurn: extra };
  if (state.winners.length >= state.players.length - 1) {
    result.gameOver = true;
    return result;
  }
  if (extra) { state.dice = null; state.rolled = false; }
  else nextTurn(state);
  return result;
}

module.exports = { createGame, rollDice, moveToken, legalMoves, SAFE_ABS, FINISH };
