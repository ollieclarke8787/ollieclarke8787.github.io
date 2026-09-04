"use strict";

/* The variation tree lives here, not on the server.
 *
 * Every node is a position. Playing a move from a node either follows an
 * existing child - so replaying a line does not duplicate it - or adds a new
 * one, which is what makes a branch. A node's first child is its main line;
 * the rest are variations, in order. Promoting a line just moves a node
 * earlier among its siblings. */

const FILES = "abcdef";
let nextId = 1;

/* A node knows its move and the position it leads to. `state` - the board,
 * hands and legal moves - is only fetched when the node is actually visited,
 * because a pasted analysis can run to hundreds of nodes and most are never
 * looked at. Nodes created by playing a move already have it. */
function makeNode(token, fen, state, parent) {
  return { id: nextId++, token, fen, state: state || null, parent, children: [] };
}

/* Make `node` current, fetching its position first if it has never been
 * visited. Everything that moves around the tree goes through here.
 *
 * The board it is leaving is read before anything changes, so the pieces can
 * be shown travelling to where they end up rather than cutting to it. A jump
 * across the tree gets the same treatment as a step along a line: the two
 * positions are matched up piece by piece. `animate: false` is for arriving
 * from somewhere the old board has nothing to do with - a new game, an import,
 * or leaving the editor. */
async function goTo(node, options = {}) {
  const leaving = app.pending ? app.pending.state : app.current && app.current.state;
  const from = options.animate === false || !leaving || node === app.current
    ? null : leaving.board;
  const hint = from ? stepHint(app.current, node) : null;

  app.pending = null;
  app.removal = null;
  app.current = node;
  if (!node.state) {
    try {
      node.state = await api("/api/state", { fen: node.fen });
    } catch (error) {
      showError(error.message);
      return;
    }
  }
  // Read off the screen last of all, so a step that arrives mid-flight picks
  // the pieces up where they have actually got to.
  const seen = from && app.animate ? visualCentres() : null;
  render({
    travel: from && { from, seen, hint, duration: options.duration || travelDuration() },
  });
}

/* One ply either way says exactly which square a piece was placed on and which
 * one, on an empty-hand turn, was graduated to place it - so those two need
 * not be guessed at. Going back, the two swap over: what was placed goes back
 * to the hand, and what was graduated comes out of it. */
function stepHint(before, after) {
  if (!before) return null;
  if (after.parent === before) return placementOf(after.token);
  if (before.parent === after) {
    const back = placementOf(before.token);
    return { enters: back.leaves, leaves: back.enters };
  }
  return null;
}

/* `Kc3`, `Cc3` and `a1>Ce3` all name the square landed on; only the third
 * names a square left behind. */
function placementOf(token) {
  if (!token) return { enters: null, leaves: null };
  const landing = token.match(/^(?:[KC]|[a-f][1-6]>C)([a-f][1-6])/);
  const source = token.match(/^([a-f][1-6])>C/);
  return { enters: landing && landing[1], leaves: source && source[1] };
}

const app = {
  root: null,
  current: null,
  pending: null,   // a placement waiting on a graduation choice
  picker: null,    // a square waiting on a kitten/cat choice
  removal: null,   // with an empty hand: the piece chosen to graduate
  menuNode: null,  // the move a context menu was opened on
  animate: true,
  editor: null,    // board editor state, when it is open
  standardStart: null,
};

/* Whose turn a position is, read off the end of its FEN. Needed before a
 * node's full state has been fetched. */
function sideToMove(fen) {
  const parts = fen.split("-");
  return parts[parts.length - 1][0];
}

/* A line that starts with grey to move is numbered "1..." for its first move,
 * the way a chess game continued from black's turn is. Positions from the
 * editor or an import can start with either side. */
function startOffset() {
  return app.root && sideToMove(app.root.fen) === "b" ? 1 : 0;
}

/* ---------------- server ---------------- */

/* There isn't one. api() is defined in api.js and answers these calls in the
 * page. The signature and the shapes are identical to the served version, so
 * everything below is the same code. */

function showError(message) {
  const box = document.getElementById("error");
  box.textContent = message || "";
  box.hidden = !message;
}

/* ---------------- colours ---------------- */

const DEFAULT_COLOURS = { a: "#ee6a10", b: "#4d5661" };

function hexToHsl(hex) {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16) / 255;
  const g = parseInt(value.slice(2, 4), 16) / 255;
  const b = parseInt(value.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return { h: 0, s: 0, l: l * 100 };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: s * 100, l: l * 100 };
}

const clampLightness = (value) => Math.max(4, Math.min(96, value));

/* The picker gives hex; the lightness slider has to shift it, which needs HSL.
 * The edge colour is the same hue a good deal darker, which is what gives a
 * piece a readable outline against any board. */
function applyPieceColours() {
  const shift = Number(document.getElementById("piece-light").value) || 0;
  const root = document.documentElement;
  for (const [side, name] of [["a", "orange"], ["b", "grey"]]) {
    const { h, s, l } = hexToHsl(document.getElementById(`colour-${side}`).value);
    const lightness = clampLightness(l + shift);
    root.style.setProperty(`--${name}`, `hsl(${h.toFixed(0)} ${s.toFixed(0)}% ${lightness.toFixed(0)}%)`);
    root.style.setProperty(
      `--${name}-edge`,
      `hsl(${h.toFixed(0)} ${s.toFixed(0)}% ${clampLightness(lightness - 22).toFixed(0)}%)`);
  }
}

/* ---------------- pieces ---------------- */

const SHAPES = {
  kit: '<polygon class="body" points="50,10 92,88 8,88" stroke-linejoin="round"/>',
  cat: '<circle class="body" cx="50" cy="50" r="42"/>',
};

const pieceCell = (owner, kind) => (kind === "cat" ? owner.toUpperCase() : owner);

function pieceMarkup(cell) {
  const owner = cell.toLowerCase() === "a" ? "a" : "b";
  const kind = cell === cell.toLowerCase() ? "kit" : "cat";
  return `<span class="piece ${owner} ${kind}"><svg viewBox="0 0 100 100">${SHAPES[kind]}</svg></span>`;
}

function poolMarkup(owner, kind, count) {
  if (!count) return '<span class="pool">&mdash;</span>';
  const cell = kind === "kit" ? owner : owner.toUpperCase();
  return `<span class="pool">${pieceMarkup(cell)}&times;${count}</span>`;
}

/* ---------------- board ---------------- */

function buildBoard() {
  const board = document.getElementById("board");
  const ranks = document.getElementById("ranks");
  const files = document.getElementById("files");
  board.innerHTML = ranks.innerHTML = files.innerHTML = "";

  for (let row = 0; row < 6; row++) {
    ranks.insertAdjacentHTML("beforeend", `<span>${6 - row}</span>`);
    for (let column = 0; column < 6; column++) {
      const name = FILES[column] + (6 - row);
      const square = document.createElement("button");
      square.className = "square";
      square.dataset.row = row;
      square.dataset.column = column;
      square.dataset.name = name;
      square.innerHTML = `<span class="coord">${name}</span>`;
      square.addEventListener("click", (event) => onSquare(square, event));
      board.appendChild(square);
    }
  }
  for (let column = 0; column < 6; column++) {
    files.insertAdjacentHTML("beforeend", `<span>${FILES[column]}</span>`);
  }
}

const squareAt = (name) => document.querySelector(`.square[data-name="${name}"]`);

const onBoard = (row, column) => row >= 0 && row < 6 && column >= 0 && column < 6;

/* What a boop did to the pieces around the placement, comparing two boards.
 *
 * A boop pushes a neighbour of the placement one square directly away, so a
 * piece that vanished from X and appeared at X + direction slid there, and one
 * that vanished from X with X + direction off the board was pushed over the
 * edge and back into its owner's hand. Only squares adjacent to the placement
 * can be sources, which keeps this unambiguous.
 *
 * `removed` is the square an empty-hand turn graduated to make its placement
 * with. That piece left too, and it can sit next to where the cat landed, so
 * it is skipped rather than read as a piece the boop moved. */
function boops(before, after, placedAt, removed) {
  const slid = [], fell = [];
  if (!placedAt) return { slid, fell };
  const [pr, pc] = placedAt;
  for (const dr of [-1, 0, 1]) {
    for (const dc of [-1, 0, 1]) {
      if (!dr && !dc) continue;
      const fromRow = pr + dr, fromColumn = pc + dc;
      if (!onBoard(fromRow, fromColumn)) continue;
      if (removed && removed[0] === fromRow && removed[1] === fromColumn) continue;
      const piece = before[fromRow][fromColumn];
      if (piece === "." || after[fromRow][fromColumn] !== ".") continue;
      const toRow = fromRow + dr, toColumn = fromColumn + dc;
      if (!onBoard(toRow, toColumn)) fell.push({ from: [fromRow, fromColumn], dr, dc, piece });
      else if (after[toRow][toColumn] === piece) slid.push({ to: [toRow, toColumn], dr, dc });
    }
  }
  return { slid, fell };
}

/* One setting drives every animation, so they all divide their own natural
   length by it and stay in proportion to each other. */
function animationSpeed() {
  return Number(document.getElementById("speed").value) || 1;
}

function slideDuration() {
  return Math.round(200 / animationSpeed());
}

/* Leaving the board covers more ground than sliding one square does, and it is
 * the last the piece is seen, so it is given longer. */
function fadeDuration() {
  return Math.round(320 / animationSpeed());
}

/* Crossing from one position to the next, when that is all that is being
 * asked for. */
const TRAVEL_MS = 260;
const BRISKEST_TRAVEL_MS = 40;

function travelDuration() {
  return Math.round(TRAVEL_MS / animationSpeed());
}

/* Steps asked for one after another get the time there actually is between
 * them. They overlap rather than queueing up behind each other - waiting for
 * each animation to finish before drawing the next is exactly what makes a
 * fast scroll feel slow - and cutting each one to the pace the wheel is
 * setting keeps the pieces up with it instead of trailing a backlog of moves.
 * A step on its own, with nothing before it, animates in full. */
function pacedDuration(since) {
  return Math.max(BRISKEST_TRAVEL_MS, Math.min(travelDuration(), Math.round(since)));
}

const squareStep = () =>
  document.querySelector(".square").getBoundingClientRect().width + 3;

function animateSlides(moved) {
  if (!moved.length) return;
  const duration = slideDuration();
  const step = squareStep();
  for (const { to, dr, dc } of moved) {
    const square = document.querySelector(
      `.square[data-row="${to[0]}"][data-column="${to[1]}"]`);
    const piece = square?.querySelector(".piece");
    if (!piece) continue;
    // Start it where it came from, then let it transition into place.
    piece.style.transform = `translate(${-dc * step}px, ${-dr * step}px)`;
    requestAnimationFrame(() => {
      piece.classList.add("sliding");
      piece.style.transform = "translate(0, 0)";
      setTimeout(() => {
        piece.classList.remove("sliding");
        piece.style.transform = "";
      }, duration + 40);
    });
  }
}

/* ---------------- moving between two positions ---------------- */

/* Stepping through a line is not always one move: clicking a move in the list
 * can land anywhere in the tree. So rather than reading a move, the two boards
 * are matched up piece by piece - like for like, each one paired with the
 * nearest square it could have come from, closest pairs settled first.
 *
 * Anything on the old board left without a partner went back to a hand, and
 * anything on the new one came out of one. A kitten that graduated is both:
 * the kitten leaves and a cat arrives, which is what happened.
 *
 * `hint` names the squares a single ply is known to have filled and emptied,
 * so the common case - a placement next to a boop, where both are one square
 * from the piece that moved - is not left to a tie-break. */
function transition(before, after, hint) {
  const gone = [], come = [];
  for (let row = 0; row < 6; row++) {
    for (let column = 0; column < 6; column++) {
      const was = before[row][column], now = after[row][column];
      if (was === now) continue;
      if (was !== ".") gone.push({ at: [row, column], cell: was });
      if (now !== ".") come.push({ at: [row, column], cell: now });
    }
  }

  const pinned = (list, name) => {
    const at = squareToIndices(name);
    return at ? list.find((item) => item.at[0] === at[0] && item.at[1] === at[1]) : null;
  };
  const spare = new Set([pinned(come, hint && hint.enters), pinned(gone, hint && hint.leaves)]);

  const pairs = [];
  for (const from of gone) {
    for (const to of come) {
      if (from.cell !== to.cell || spare.has(from) || spare.has(to)) continue;
      pairs.push({ from, to, gap: Math.hypot(from.at[0] - to.at[0], from.at[1] - to.at[1]) });
    }
  }
  pairs.sort((one, other) => one.gap - other.gap);

  const moves = [], taken = new Set();
  for (const { from, to } of pairs) {
    if (taken.has(from) || taken.has(to)) continue;
    taken.add(from); taken.add(to);
    moves.push({ from: from.at, to: to.at });
  }
  return {
    moves,
    arrivals: come.filter((item) => !taken.has(item)),
    departures: gone.filter((item) => !taken.has(item)),
  };
}

const centreOf = (element) => {
  const box = element.getBoundingClientRect();
  return [box.left + box.width / 2, box.top + box.height / 2];
};

/* Where a piece of this colour comes from, and goes back to. */
const handCentre = (cell) =>
  centreOf(document.getElementById(`hand-${cell.toLowerCase() === "a" ? "a" : "b"}`));

/* How far a piece has to travel to get from its square to the hand. */
function reachToHand(square, cell) {
  const [hx, hy] = handCentre(cell);
  const [sx, sy] = centreOf(square);
  return `translate(${hx - sx}px, ${hy - sy}px) scale(.35)`;
}

const squareAtIndex = (row, column) =>
  document.querySelector(`.square[data-row="${row}"][data-column="${column}"]`);

/* Where every piece is on screen at this moment, part-way through whatever it
 * was already doing. Keyed by the square it is in, because that is what the
 * next position has to match it up with.
 *
 * A step that arrives while the last one is still moving starts from what the
 * eye can see rather than from where the pieces logically were, so overlapping
 * steps flow into one another instead of snapping back to begin again. */
function visualCentres() {
  const centres = new Map();
  for (const square of document.querySelectorAll(".square")) {
    const piece = square.querySelector(".piece");
    if (!piece) continue;
    const transform = getComputedStyle(piece).transform;
    centres.set(`${square.dataset.row},${square.dataset.column}`, {
      centre: centreOf(piece),
      scale: transform === "none" ? 1 : new DOMMatrix(transform).a,
      opacity: getComputedStyle(piece).opacity,
    });
  }
  return centres;
}

/* The transform that puts a piece back exactly where it was last seen, written
 * relative to whichever square it is sitting in now. */
function resumeFrom(seen, at, square) {
  const was = seen && seen.get(`${at[0]},${at[1]}`);
  if (!was) return null;
  const [sx, sy] = centreOf(square);
  return {
    transform:
      `translate(${was.centre[0] - sx}px, ${was.centre[1] - sy}px) scale(${was.scale})`,
    opacity: was.opacity,
  };
}

/* Draw the change from one position to the next.
 *
 * The board has already been drawn as it will end up, so a piece that moved is
 * pushed back to where it came from and let go; one that arrived starts small
 * over its owner's hand and grows into place. Only a piece that left has
 * nothing on the board to animate, so that one flies as a copy. */
function animateTravel(before, after, seen, hint, duration) {
  const { moves, arrivals, departures } = transition(before, after, hint);
  if (!moves.length && !arrivals.length && !departures.length) return;

  const board = document.getElementById("board");
  board.style.setProperty("--travel-ms", `${duration}ms`);
  const step = squareStep();
  const started = [];

  const begin = (square, transform, opacity) => {
    const piece = square && square.querySelector(".piece");
    if (!piece) return;
    piece.style.transform = transform;
    if (opacity !== null) piece.style.opacity = opacity;
    // A piece crossing the board passes over squares that would otherwise
    // paint on top of it, so its own square is lifted for the trip.
    square.classList.add("lifted");
    started.push(piece);
  };

  for (const { from, to } of moves) {
    const square = squareAtIndex(to[0], to[1]);
    if (!square) continue;
    const carried = resumeFrom(seen, from, square);
    begin(square,
      carried ? carried.transform
        : `translate(${(from[1] - to[1]) * step}px, ${(from[0] - to[0]) * step}px)`,
      carried ? carried.opacity : null);
  }
  for (const { at, cell } of arrivals) {
    const square = squareAtIndex(at[0], at[1]);
    if (square) begin(square, reachToHand(square, cell), "0");
  }

  if (started.length) {
    // Commit where everything starts before turning the transitions on, or the
    // browser is free to collapse the two into no movement at all.
    void board.offsetWidth;
    for (const piece of started) {
      piece.classList.add("travelling");
      piece.style.transform = "translate(0, 0)";
      piece.style.opacity = "";
    }
    setTimeout(() => {
      for (const piece of started) {
        piece.classList.remove("travelling");
        piece.style.transform = "";
        piece.style.opacity = "";
        if (piece.parentElement) piece.parentElement.classList.remove("lifted");
      }
    }, duration + 40);
  }

  for (const { at, cell } of departures) {
    const square = squareAtIndex(at[0], at[1]);
    if (!square) continue;
    const copy = ghost(square, cell);
    // Its own square is where the copy is put; if the piece it stands in for
    // had not got there yet, it starts from where it had.
    const carried = resumeFrom(seen, at, square);
    if (carried) copy.style.transform = carried.transform;
    sendOff(copy, reachToHand(square, cell), duration);
  }
}

/* ---------------- pieces leaving the board ---------------- */

/* A piece that leaves the board - graduated into a hand, or booped over an
 * edge - is already gone from the position the board has just drawn, so there
 * is nothing left in its square to animate. A copy of it is laid over the page
 * where it stood, sent on its way, and dropped when it gets there.
 *
 * Page coordinates rather than the square's own: the layer holding the copies
 * sits at the document origin, and a graduated piece is headed somewhere the
 * board does not reach. */
function ghost(square, cell) {
  const box = square.getBoundingClientRect();
  const node = document.createElement("div");
  node.className = "ghost";
  node.style.left = `${window.scrollX + box.left}px`;
  node.style.top = `${window.scrollY + box.top}px`;
  node.style.width = `${box.width}px`;
  node.style.height = `${box.height}px`;
  node.innerHTML = pieceMarkup(cell);
  document.getElementById("ghosts").appendChild(node);
  return node;
}

function sendOff(node, transform, duration) {
  // Whatever is flying it says how long it has; the setting is already in the
  // duration by the time it gets here.
  node.style.setProperty("--fade-ms", `${duration}ms`);
  // The starting state has to be committed before the transition is switched
  // on, or the browser is free to collapse the two into no movement at all.
  void node.offsetWidth;
  node.classList.add("leaving");
  node.style.transform = transform;
  setTimeout(() => node.remove(), duration + 80);
}

/* Anything still in flight belongs to the position that was on the board a
 * moment ago, so a new one clears it rather than letting the two overlap. */
function clearGhosts() {
  document.getElementById("ghosts").replaceChildren();
}

/* Booped over the edge: out the way it was pushed, past the frame, fading. */
function animateFalls(fell) {
  if (!fell.length) return;
  const duration = fadeDuration();
  const step = squareStep();
  for (const { from, dr, dc, piece } of fell) {
    const square = document.querySelector(
      `.square[data-row="${from[0]}"][data-column="${from[1]}"]`);
    if (!square) continue;
    sendOff(ghost(square, piece),
      `translate(${dc * step * 1.4}px, ${dr * step * 1.4}px) scale(.75)`, duration);
  }
}

/* Graduated: the three pieces of the line head for the hand they are going
 * into, shrinking towards the size they are drawn at there. Which hand they
 * fly to is the whole point - it is what says whose the line was - so they go
 * there rather than in some direction of their own. */
function animateCollection({ owner, squares }) {
  const hand = document.getElementById(`hand-${owner}`);
  if (!hand || !squares.length) return;
  const duration = fadeDuration();
  const target = hand.getBoundingClientRect();
  for (const { name, cell } of squares) {
    const square = squareAt(name);
    if (!square) continue;
    const box = square.getBoundingClientRect();
    const dx = target.left + target.width / 2 - (box.left + box.width / 2);
    const dy = target.top + target.height / 2 - (box.top + box.height / 2);
    sendOff(ghost(square, cell), `translate(${dx}px, ${dy}px) scale(.35)`, duration);
  }
}

function render(options = {}) {
  clearGhosts();
  if (app.editor) return renderEditorBoard();
  const node = app.current;
  // While a graduation choice is open the board shows the position after the
  // placement, which is not yet a node in the tree.
  const state = app.pending ? app.pending.state : node.state;

  for (const square of document.querySelectorAll(".square")) {
    const cell = state.board[+square.dataset.row][+square.dataset.column];
    const coord = square.querySelector(".coord").outerHTML;
    square.innerHTML = coord + (cell === "." ? "" : pieceMarkup(cell));
    square.classList.remove(
      "playable", "highlight", "last", "source", "selected", "target", "lifted");
    square.disabled = true;
  }

  if (isRemovalTurn(state)) {
    markRemovalTurn(state);
  } else if (!state.isOver && state.mode === "play") {
    for (const move of state.legal) {
      const square = squareAt(move.square);
      if (square) { square.disabled = false; square.classList.add("playable"); }
    }
  }

  const token = app.pending ? app.pending.token : node.token;
  const landed = token && token.match(/([a-f][1-6])(?:=|$|#)/);
  const placed = token && token.match(/^(?:[KC]|[a-f][1-6]>C)([a-f][1-6])/);
  if (placed) squareAt(placed[1])?.classList.add("last");
  else if (landed) squareAt(landed[1])?.classList.add("last");

  renderHands(state);
  renderStatus(state);
  renderNotation();
  renderGraduation(state);
  document.getElementById("fen").value = state.fen;
  document.getElementById("movetext").value = exportText();

  document.getElementById("back").disabled = !node.parent;
  document.getElementById("forward").disabled = node.children.length === 0;
  document.getElementById("delete-branch").disabled = !node.parent;
  document.getElementById("promote").disabled = !canPromote(node);
  document.getElementById("make-main").disabled = !canMakeMain(node);

  if (app.animate) {
    if (options.slid) animateSlides(options.slid);
    if (options.fell) animateFalls(options.fell);
    if (options.collected) animateCollection(options.collected);
    if (options.travel) {
      animateTravel(options.travel.from, state.board,
        options.travel.seen, options.travel.hint, options.travel.duration);
    }
  }
}

/* With every piece on the board a turn is "graduate one of your own and place
 * it as a cat". That is two choices, and several sources can reach the same
 * square, so asking for the destination alone cannot say which piece to take.
 * The board asks for the piece first, which is also the order the notation
 * reads: a1>Ce3. */
function isRemovalTurn(state) {
  return (
    !state.isOver &&
    state.mode === "play" &&
    state.legal.length > 0 &&
    state.legal.every((move) => move.kind === "graduate_place")
  );
}

function removalSources(state) {
  return new Set(state.legal.map((move) => move.source));
}

function markRemovalTurn(state) {
  for (const name of removalSources(state)) {
    const square = squareAt(name);
    if (!square) continue;
    square.disabled = false;
    square.classList.add("playable", "source");
  }
  if (!app.removal) return;

  squareAt(app.removal)?.classList.add("selected");
  for (const move of state.legal) {
    if (move.source !== app.removal) continue;
    const square = squareAt(move.square);
    if (!square) continue;
    square.disabled = false;
    square.classList.add("playable", "target");
  }
}

function renderHands(state) {
  for (const owner of ["a", "b"]) {
    const box = document.getElementById(`hand-${owner}`);
    const hand = state.hands[owner];
    const active = state.turn === owner && !state.isOver;
    box.className = "hand" + (active ? " active" : "");
    box.innerHTML =
      `<span class="turn"></span>` +
      `<span class="name">${owner === "a" ? "Orange" : "Grey"}</span>` +
      poolMarkup(owner, "kit", hand.kits) +
      poolMarkup(owner, "cat", hand.cats);
  }
}

function renderStatus(state) {
  const status = document.getElementById("status");
  const name = state.turn === "a" ? "Orange" : "Grey";
  if (state.isOver) status.textContent = `${state.winner === "a" ? "Orange" : "Grey"} wins`;
  else if (state.mode === "trip") status.textContent = "Choose a line to graduate";
  else if (app.picker) status.textContent = "Kitten or cat?";
  else if (isRemovalTurn(state)) {
    status.textContent = app.removal
      ? `${name}: place the cat from ${app.removal} - Esc to pick again`
      : `${name} has every piece on the bed: choose one to graduate`;
  } else status.textContent = `${name} to place`;
}

/* ---------------- placing ---------------- */

function onSquare(square, event) {
  closePicker();
  closeContext();
  // While editing, a pointer has already been dealt with by the painting
  // stroke. Only a keyboard press reaches here - which reports no clicks.
  if (app.editor) {
    if (!event || event.detail === 0) editorSquare(square);
    return;
  }
  const state = app.pending ? app.pending.state : app.current.state;
  if (state.isOver || state.mode !== "play") return;
  const name = square.dataset.name;

  if (isRemovalTurn(state)) {
    const sources = removalSources(state);
    if (app.removal) {
      const move = state.legal.find(
        (option) => option.source === app.removal && option.square === name);
      if (move) { app.removal = null; return playMove(move); }
    }
    // Any of your own pieces can be picked, including instead of the one
    // already chosen.
    if (sources.has(name)) { app.removal = name; return render(); }
    return;
  }

  const options = state.legal.filter((move) => move.square === name);
  if (options.length === 0) return;
  if (options.length === 1) return playMove(options[0]);
  openPicker(square, options);
}

function openPicker(square, options) {
  const picker = document.getElementById("picker");
  const state = app.pending ? app.pending.state : app.current.state;
  app.picker = { square, options };
  picker.hidden = false;
  // The swatches show whose pieces are being placed, so grey's turn offers
  // grey icons rather than orange ones.
  picker.style.setProperty(
    "--swatch", `var(--${state.turn === "a" ? "orange" : "grey"})`);
  const box = square.getBoundingClientRect();
  picker.style.left = `${window.scrollX + box.left + box.width / 2 - picker.offsetWidth / 2}px`;
  picker.style.top = `${window.scrollY + box.bottom + 6}px`;
  for (const button of picker.querySelectorAll("button")) {
    const option = options.find((move) => move.piece === button.dataset.piece);
    button.disabled = !option;
    button.onclick = () => { closePicker(); if (option) playMove(option); };
  }
  renderStatus(app.current.state);
}

function closePicker() {
  app.picker = null;
  document.getElementById("picker").hidden = true;
}

async function playMove(move) {
  showError("");
  const state = app.pending ? app.pending.state : app.current.state;
  const before = state.board;
  const mover = state.turn;
  try {
    const result = await api("/api/play", {
      fen: state.fen,
      move: move.move,
    });
    const placedAt = squareToIndices(move.square);
    const removed = squareToIndices(move.source);
    const moved = boops(before, result.board, placedAt, removed);

    if (result.mode === "trip" && !result.isOver) {
      app.pending = { node: app.current, token: move.token, state: result };
      render(moved);
      return;
    }
    // A single completed line graduates inside the same call as the placement,
    // so this is the usual way a triple comes off the board - the picker only
    // appears when there are two to choose between.
    const settled = { placedAt, placedCell: pieceCell(mover, move.piece), removed, ...moved };
    const squares = graduatedSquares(result.token).map((name) =>
      ({ name, cell: settledCell(before, name, settled) }));
    advance(result, result.token,
      { ...moved, collected: squares.length ? { owner: mover, squares } : null });
  } catch (error) {
    showError(error.message);
  }
}

function squareToIndices(name) {
  return name ? [6 - Number(name[1]), FILES.indexOf(name[0])] : null;
}

function cellAt(board, name) {
  const [row, column] = squareToIndices(name);
  return board[row][column];
}

/* A line that graduates on its own is settled by the server inside the same
 * call as the placement, and the only thing sent back saying which line it was
 * is the token: `Kc1=a1b1c1`, or `a1>Ce3=c1d2e3`. */
function graduatedSquares(token) {
  const match = token && token.match(/=((?:[a-f][1-6])+)/);
  return match ? match[1].match(/[a-f][1-6]/g) : [];
}

/* What stood on a square once the placement and its boops had settled, which
 * is the board the graduating line was standing on. Neither board the server
 * sends shows it: one is from before the move, the other from after the line
 * came off. */
function settledCell(before, name, { placedAt, placedCell, removed, slid }) {
  const [row, column] = squareToIndices(name);
  const here = (position) => position && position[0] === row && position[1] === column;
  if (here(placedAt)) return placedCell;
  if (here(removed)) return ".";
  const arrival = slid.find(({ to }) => here(to));
  if (arrival) return before[row - arrival.dr][column - arrival.dc];
  return before[row][column];
}

async function chooseGraduation(option) {
  const pending = app.pending;
  // Read off the board the graduation is leaving, since the next render draws
  // the one it left behind.
  const collected = {
    owner: pending.state.turn,
    squares: option.squares.map((name) => ({ name, cell: cellAt(pending.state.board, name) })),
  };
  try {
    const result = await api("/api/play", { fen: pending.state.fen, move: option.move });
    const token = pending.token + result.graduationSuffix + (result.isOver ? "#" : "");
    app.current = pending.node;
    app.pending = null;
    advance(result, token, { collected });
  } catch (error) {
    showError(error.message);
  }
}

function advance(state, token, animation) {
  const parent = app.current;
  const existing = parent.children.find((child) => child.token === token);
  if (existing) {
    existing.state = existing.state || state;
    app.current = existing;
  } else {
    const node = makeNode(token, state.fen, state, parent);
    parent.children.push(node);
    app.current = node;
  }
  app.pending = null;
  app.removal = null;
  render(animation);
}

/* ---------------- graduation choices ---------------- */

function renderGraduation(state) {
  const card = document.getElementById("graduation-card");
  const list = document.getElementById("graduation-options");
  const choosing = !state.isOver && state.mode === "trip";
  card.hidden = !choosing;
  list.innerHTML = "";
  if (!choosing) return;

  for (const option of state.legal.filter((move) => move.kind === "graduate")) {
    const item = document.createElement("li");
    const kittens = option.pieces.filter((p) => p === p.toLowerCase()).length;
    item.innerHTML = `<span>${option.squares.join(" ")}</span>` +
      `<span class="kind">${kittens} kitten${kittens === 1 ? "" : "s"}</span>`;
    item.addEventListener("mouseenter", () => highlight(option.squares, true));
    item.addEventListener("mouseleave", () => highlight(option.squares, false));
    item.addEventListener("click", () => { highlight(option.squares, false); chooseGraduation(option); });
    list.appendChild(item);
  }
}

function highlight(squares, on) {
  squares.forEach((name) => squareAt(name)?.classList.toggle("highlight", on));
}

/* ---------------- notation ---------------- */

function pathTo(node) {
  const path = [];
  for (let step = node; step && step.parent; step = step.parent) path.unshift(step);
  return path;
}

function lineToText(node) {
  return pathTo(node).map((step, index) => numbered(step.token, index)).join(" ");
}

/* "2." before an orange move, "2..." before a grey one. */
function moveLabel(ply) {
  const at = ply + startOffset();
  return `${Math.floor(at / 2) + 1}${at % 2 ? "..." : "."}`;
}

/* A move carries a number when it is orange's, or when it opens a run of text
 * and so has nothing before it to be counted from. Three things open a run:
 * the first move of the game, the first move of a variation, and the move
 * that picks the main line up again after a variation has interrupted it.
 * Any of the three can be grey's, which is what the "..." is for.
 *
 * The moves that merely *follow* one of those are not opening anything.
 * Numbering them too gave "2. Kd4 2... Kb3" for a variation whose two moves
 * are the two halves of a single move. */
function numbered(token, ply, startsRun = false) {
  const at = ply + startOffset();
  return at % 2 === 0 || startsRun ? `${moveLabel(ply)} ${token}` : token;
}

/* The whole tree as text, variations in brackets, PGN-style:
 *
 *   1. Kc3 Kd4 2. Kc4 (2. Ke5 Kf6) 2... Kb1
 *
 * A variation that starts on a reply is numbered `2...` so it is clear which
 * half of the move it replaces. Reading a list back ignores the brackets, so
 * this can be pasted straight into the box it came from. */
function treeToText(from, ply) {
  const parts = [];
  let node = from;
  let index = ply;

  // True once brackets have come between the reader and the main line.
  let interrupted = false;

  while (node.children.length) {
    const [main, ...branches] = node.children;
    parts.push(numbered(main.token, index, index === 0 || interrupted));

    for (const branch of branches) {
      const inner = [numbered(branch.token, index, true)];
      const rest = treeToText(branch, index + 1);
      if (rest) inner.push(rest);
      parts.push(`(${inner.join(" ")})`);
    }

    interrupted = branches.length > 0;
    node = main;
    index += 1;
  }
  return parts.join(" ");
}

/* What the move-list box shows, and what Copy puts on the clipboard: the main
 * line, optionally with its variations. Which line is "main" is whatever is
 * first at each branch, so "make main line" is how you choose what gets
 * exported. */
function exportText() {
  const withVariations = document.getElementById("with-variations")?.checked;
  const moves = withVariations ? treeToText(app.root, 0) : mainLineToText();
  const tag = setupTag(app.root?.fen);
  return [tag, moves].filter(Boolean).join(" ").trim();
}

function mainLineToText() {
  const parts = [];
  let node = app.root;
  let index = 0;
  while (node.children.length) {
    node = node.children[0];
    parts.push(numbered(node.token, index, index === 0));
    index += 1;
  }
  return parts.join(" ");
}

/* At a position with more than one recorded continuation, every one of them
 * is marked - the indentation says which is the main line, but only if you are
 * reading the shape of the list rather than the position in front of you. The
 * alternatives take an arrow as well, so the main line is still the one
 * without. */
function choiceClass(node) {
  const choices = app.current.children;
  if (choices.length < 2 || node.parent !== app.current) return "";
  return choices.indexOf(node) === 0 ? " choice" : " choice alt";
}

function plySpan(node) {
  const span = document.createElement("span");
  span.className = "ply" + (node.id === app.current.id ? " current" : "")
    + choiceClass(node);
  span.textContent = node.token;
  span.title = node.fen;
  span.addEventListener("click", () => step(() => node));
  span.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openContext(node, event.pageX, event.pageY);
  });
  return span;
}

function setupTag(fen) {
  return !fen || fen === app.standardStart ? "" : `[FEN "${fen}"]`;
}

function renderNotation() {
  const box = document.getElementById("notation");
  box.innerHTML = "";

  // A line that does not start from the opening position has to say where it
  // does start, or its moves mean nothing.
  const tag = setupTag(app.editor ? app.editor.fen : app.root?.fen);
  if (tag) {
    const element = document.createElement("span");
    element.className = "setup-tag";
    element.innerHTML = `<b>Position</b> ${tag}`;
    box.appendChild(element);
  }

  if (app.editor) {
    const note = document.createElement("span");
    note.className = "empty";
    note.textContent = app.editor.fen
      ? "Continue from here to start a line."
      : "Set up a legal position to continue from.";
    box.appendChild(note);
    return;
  }

  if (app.root.children.length === 0) {
    box.insertAdjacentHTML("beforeend", '<span class="empty">No moves yet.</span>');
    return;
  }
  box.appendChild(renderLine(app.root, 0));
  // Wheeling through a long line is no use if the move you are on has scrolled
  // out of the list.
  revealInBox(box, box.querySelector(".ply.current"));
}

/* Scroll `element` into view inside `box`, and move nothing else.
 *
 * scrollIntoView would do this, but it walks up every scrollable ancestor as
 * well - so on a phone, where the list sits in the page rather than in a
 * column of its own, every move dragged the whole page off the board. */
function revealInBox(box, element) {
  if (!element) return;
  const frame = box.getBoundingClientRect();
  const item = element.getBoundingClientRect();
  if (item.top < frame.top) box.scrollTop -= frame.top - item.top;
  else if (item.bottom > frame.bottom) box.scrollTop += item.bottom - frame.bottom;
}

function moveNumber(index) {
  const span = document.createElement("span");
  span.className = "number";
  span.textContent = moveLabel(index);
  return span;
}

/* The main line runs along each node's first child; any further children are
 * variations.
 *
 * Two layouts. `indented` gives each variation its own line, left-justified,
 * one entry per variation and indented from the line it branches off; a
 * variation inside a variation indents again, so depth is readable at a
 * glance, and the main line picks up underneath. `inline` runs them into the
 * text in brackets, which is compact but harder to scan once they nest. */
/* `opensRun` says whether the first move rendered here begins a run of text.
 * The main line does. A variation's continuation does not: its first move was
 * already written, with its number, by the branch that introduced it. */
function renderLine(from, ply, opensRun = true) {
  const inline = document.body.dataset.moves === "inline";
  const fragment = document.createDocumentFragment();
  let node = from;
  let index = ply;
  let interrupted = false;

  while (node.children.length) {
    const [main, ...branches] = node.children;

    // A number goes before every orange move, and before a grey one that
    // opens a run of text - see `numbered`, which decides the same thing for
    // the exported version.
    const startsRun = interrupted || (opensRun && index === ply);
    if ((index + startOffset()) % 2 === 0 || startsRun) {
      fragment.appendChild(moveNumber(index));
    }
    fragment.appendChild(plySpan(main));
    fragment.appendChild(document.createTextNode(" "));

    for (const branch of branches) {
      const wrapper = document.createElement(inline ? "span" : "div");
      wrapper.className = "variation";
      if (inline) wrapper.appendChild(document.createTextNode("("));
      wrapper.appendChild(moveNumber(index));
      wrapper.appendChild(plySpan(branch));
      wrapper.appendChild(document.createTextNode(" "));
      wrapper.appendChild(renderLine(branch, index + 1, false));
      if (inline) {
        // Every move is followed by a space, so trim the trailing one and
        // close tight - otherwise brackets read as "Kf1 )" and, once nested,
        // "(2.Kb1) )". The separator goes outside the bracket instead.
        const tail = wrapper.lastChild;
        if (tail && tail.nodeType === Node.TEXT_NODE && !tail.textContent.trim()) {
          wrapper.removeChild(tail);
        }
        wrapper.appendChild(document.createTextNode(")"));
      }
      fragment.appendChild(wrapper);
      if (inline) fragment.appendChild(document.createTextNode(" "));
    }

    interrupted = branches.length > 0;
    node = main;
    index += 1;
  }
  return fragment;
}

/* ---------------- branch priority ---------------- */

/* Promoting works on the point where this line diverges, not on the move you
 * happen to be looking at - otherwise promoting from deep inside a variation
 * would shuffle moves that are not the reason the line is a variation.
 *
 * The nearest such point, not the outermost one: a variation inside a
 * variation is promoted within the line it branches off, and whether that line
 * is itself a variation is a separate question, answered by promoting again. */
function branchPoint(node) {
  for (let step = node; step && step.parent; step = step.parent) {
    if (step.parent.children.indexOf(step) > 0) return step;
  }
  return null;
}

/* Make-main-line needs a divergence anywhere above it, not just the nearest
 * one: a line already first among its siblings can still be a variation
 * further up, and that is exactly what it is for. */
const canPromote = (node) => Boolean(branchPoint(node));
const canMakeMain = (node) => pathTo(node).some(
  (step) => step.parent.children.indexOf(step) > 0);

/* Take this line to the front of the branch it hangs off, so it becomes the
 * line at that level and the others fall in behind it in the order they were.
 * One level only: a line two variations deep comes up one, and stays a
 * variation of whatever the outer one is a variation of. */
function promoteVariation(node) {
  const anchor = branchPoint(node);
  if (!anchor) return;
  const siblings = anchor.parent.children;
  siblings.splice(siblings.indexOf(anchor), 1);
  siblings.unshift(anchor);
  render();
}

/* Make every step of this line the first child of its parent, so the line
 * becomes the principal one. The old main line drops to second, and the other
 * variations keep their order behind it. */
function makeMainLine(node) {
  for (let step = node; step && step.parent; step = step.parent) {
    const siblings = step.parent.children;
    const index = siblings.indexOf(step);
    if (index > 0) {
      siblings.splice(index, 1);
      siblings.unshift(step);
    }
  }
  render();
}

function deleteFrom(node) {
  if (!node.parent) return;
  node.parent.children = node.parent.children.filter((child) => child !== node);
  if (pathTo(app.current).includes(node) || app.current === node) {
    return goTo(node.parent);
  }
  app.pending = null;
  render();
}

/* ---------------- context menu ---------------- */

function openContext(node, x, y) {
  const menu = document.getElementById("context");
  app.menuNode = node;
  menu.hidden = false;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const promotable = canPromote(node);
  menu.querySelector('[data-action="promote"]').classList.toggle("disabled", !promotable);
  menu.querySelector('[data-action="make-main"]').classList.toggle("disabled", !promotable);
}

function closeContext() {
  app.menuNode = null;
  document.getElementById("context").hidden = true;
}

/* ---------------- navigation ---------------- */

/* Steps can be asked for faster than one takes to draw - a flick of the wheel
 * is several at once, and the arrow key repeats. They still go one at a time,
 * because a step has to know the position the one before it reached and a
 * position that has never been visited has to be fetched first. But only the
 * drawing is serialised: nothing waits for an animation to end. Each one is
 * cut to the pace being set and the next picks the pieces up wherever they
 * have got to, so the board keeps up with the wheel and the pieces flow
 * through the positions instead of the scroll queueing up behind them. */
const steps = { queue: [], running: false, last: 0 };

function step(pick) {
  steps.queue.push(pick);
  if (!steps.running) drainSteps();
}

async function drainSteps() {
  steps.running = true;
  try {
    while (steps.queue.length) {
      const node = steps.queue.shift()();
      if (!node || node === app.current) continue;
      const now = performance.now();
      // `last` is not cleared between runs: a step that follows a long pause
      // is on its own however many came before it, and animates in full.
      const duration = pacedDuration(now - steps.last);
      steps.last = now;
      await goTo(node, { duration });
    }
  } finally {
    steps.running = false;
  }
}

function back() {
  // A graduation choice is half a move: backing out of it goes no further.
  if (app.pending) { app.pending = null; render(); return; }
  step(() => app.current.parent);
}

function forward() {
  step(() => app.current.children[0] || null);
}

/* ---------------- loading ---------------- */

async function newGame(fen) {
  showError("");
  try {
    const state = await api("/api/state", { fen: fen || null });
    // The opening position is whatever a game with no FEN starts from. Learn
    // it here, before anything renders: a tag is written for a start that is
    // not the opening one, and until this is known the opening position does
    // not match itself.
    if (!fen && !app.standardStart) app.standardStart = state.fen;
    app.root = makeNode(null, state.fen, state, null);
    app.pending = null;
    await goTo(app.root, { animate: false });
  } catch (error) {
    showError(error.message);
  }
}

async function loadMoves() {
  showError("");
  try {
    const tree = await api("/api/tree", {
      moves: document.getElementById("movetext").value, fen: null });

    app.root = makeNode(null, tree.fen, null, null);
    graft(app.root, tree.children);

    // Land at the end of the main line, which is where you were reading.
    let last = app.root;
    while (last.children.length) last = last.children[0];
    await goTo(last, { animate: false });
  } catch (error) {
    showError(error.message);
  }
}

function graft(parent, children) {
  for (const child of children) {
    const node = makeNode(child.token, child.fen, null, parent);
    parent.children.push(node);
    graft(node, child.children);
  }
}

async function copy(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const was = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => { button.textContent = was; }, 900);
  } catch {
    showError("Could not reach the clipboard; select the text and copy manually.");
  }
}

/* ---------------- resizing ---------------- */

function setBoardSize(pixels) {
  const size = Math.round(Math.min(760, Math.max(260, pixels)));
  document.documentElement.style.setProperty("--board-size", `${size}px`);
  store("board-size", size);
}

function wireResize() {
  const handle = document.getElementById("resize");
  const wrap = document.getElementById("board-wrap");
  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("dragging");
    const left = wrap.getBoundingClientRect().left;

    const move = (moveEvent) => setBoardSize(moveEvent.clientX - left);
    const stop = () => {
      handle.classList.remove("dragging");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
  });
}

/* ---------------- board editor ---------------- */

const BRUSHES = { "a-kit": "a", "a-cat": "A", "b-kit": "b", "b-cat": "B", delete: "." };

/* Right-clicking while editing swaps the brush for the other player's piece of
 * the same kind - laying out a position means alternating colours constantly,
 * and the tiles are a round trip away from the board. */
const OTHER_COLOUR = {
  "a-kit": "b-kit", "b-kit": "a-kit", "a-cat": "b-cat", "b-cat": "a-cat",
};

function enterEditor() {
  const state = app.current.state;
  app.editor = {
    brush: "a-kit",
    board: state.board.map((row) => [...row]),
    turn: state.turn,
    hands: { a: { ...state.hands.a }, b: { ...state.hands.b } },
    fen: null,          // set once the server accepts the position
    stroke: null,       // what the pointer is painting, while it is down
  };
  document.body.dataset.editing = "1";
  document.getElementById("palette").hidden = false;
  document.getElementById("editor-card").hidden = false;
  document.getElementById("graduation-card").hidden = true;
  document.getElementById("toggle-editor").textContent = "Close editor";
  document.getElementById("editor-turn").value = app.editor.turn;
  for (const side of ["a", "b"]) {
    document.getElementById(`hand-${side}-kits`).value = app.editor.hands[side].kits;
    document.getElementById(`hand-${side}-cats`).value = app.editor.hands[side].cats;
  }
  paintPalette();
  validateEditor();
}

function leaveEditor() {
  app.editor = null;
  delete document.body.dataset.editing;
  document.getElementById("palette").hidden = true;
  document.getElementById("editor-card").hidden = true;
  document.getElementById("toggle-editor").textContent = "Board editor";
  render();
}

function paintPalette() {
  // The clear-the-board tile carries no brush; it acts, rather than arming.
  for (const tile of document.querySelectorAll(".palette .tile[data-brush]")) {
    const brush = tile.dataset.brush;
    tile.classList.toggle("active", app.editor?.brush === brush);
    if (brush !== "delete") tile.innerHTML = pieceMarkup(BRUSHES[brush]);
  }
}

function clearEditorBoard() {
  app.editor.board = Array.from({ length: 6 }, () => Array(6).fill("."));
  app.editor.hands = { a: { kits: 8, cats: 0 }, b: { kits: 8, cats: 0 } };
  for (const side of ["a", "b"]) {
    document.getElementById(`hand-${side}-kits`).value = 8;
    document.getElementById(`hand-${side}-cats`).value = 0;
  }
  renderEditorBoard();
  validateEditor();
}

/* What a stroke starting on this square should write everywhere it goes.
 *
 * Clicking a square that already holds the selected piece takes it off again,
 * so a tile is its own undo. Deciding that once, from the square the stroke
 * starts on, is what lets a drag stay coherent: sweeping over a row of your
 * own kittens clears the row rather than flickering each square on and off. */
function strokeValue(square) {
  const wanted = BRUSHES[app.editor.brush];
  return editorCell(square) === wanted ? "." : wanted;
}

const editorCell = (square) =>
  app.editor.board[+square.dataset.row][+square.dataset.column];

function paintSquare(square) {
  if (editorCell(square) === app.editor.stroke) return;   // already what it should be
  app.editor.board[+square.dataset.row][+square.dataset.column] = app.editor.stroke;
  renderEditorBoard();
  validateEditor();
}

/* The pointer is captured by the board, so events report the board rather than
 * whatever is under the finger. Ask what is under it. */
function paintUnder(x, y) {
  const under = document.elementFromPoint(x, y);
  const square = under && under.closest && under.closest(".square");
  if (square) paintSquare(square);
}

/* The keyboard path. A pointer goes through the stroke handlers below, which
 * cover the drag as well; this is what Enter or Space on a focused square
 * does, and it is one square's worth of the same thing. */
function editorSquare(square) {
  app.editor.stroke = strokeValue(square);
  paintSquare(square);
  app.editor.stroke = null;
}

/* Press, drag, release: every square the pointer touches takes the stroke's
 * value. */
function wireEditorPainting() {
  const board = document.getElementById("board");

  board.addEventListener("pointerdown", (event) => {
    if (!app.editor || event.button !== 0) return;
    const square = event.target.closest(".square");
    if (!square) return;
    event.preventDefault();          // no text selection, no drag-and-drop
    app.editor.stroke = strokeValue(square);
    app.editor.at = { x: event.clientX, y: event.clientY };
    paintSquare(square);
    // Touch captures the pointer to this square on its own; taking the capture
    // for the whole board makes mouse and touch behave the same way.
    board.setPointerCapture(event.pointerId);
  });

  board.addEventListener("pointermove", (event) => {
    if (!app.editor || app.editor.stroke === null) return;
    const to = { x: event.clientX, y: event.clientY };
    const from = app.editor.at || to;
    // A quick drag reports a handful of widely spaced points, so walk the line
    // between them in thirds of a square. Sampling only where the pointer was
    // seen leaves gaps in the middle of the stroke.
    const step = Math.max(6, board.getBoundingClientRect().width / 18);
    const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / step));
    for (let i = 1; i <= steps; i++) {
      paintUnder(from.x + ((to.x - from.x) * i) / steps,
                 from.y + ((to.y - from.y) * i) / steps);
    }
    app.editor.at = to;
  });

  const endStroke = () => {
    if (app.editor) { app.editor.stroke = null; app.editor.at = null; }
  };
  board.addEventListener("pointerup", endStroke);
  board.addEventListener("pointercancel", endStroke);
  window.addEventListener("pointerup", endStroke);

  // Right-click over the board swaps colours too, so laying out both sides
  // never needs the tiles.
  board.addEventListener("contextmenu", (event) => {
    if (!app.editor) return;
    event.preventDefault();
    swapBrushColour();
  });
}

function swapBrushColour() {
  const other = OTHER_COLOUR[app.editor.brush];
  if (!other) return;              // the eraser has no other colour
  app.editor.brush = other;
  paintPalette();
}

function renderEditorBoard() {
  for (const square of document.querySelectorAll(".square")) {
    const cell = app.editor.board[+square.dataset.row][+square.dataset.column];
    const coord = square.querySelector(".coord").outerHTML;
    square.innerHTML = coord + (cell === "." ? "" : pieceMarkup(cell));
    square.classList.remove(
      "playable", "highlight", "last", "source", "selected", "target");
    square.disabled = false;
  }
}

/* Ask the server whether the position is playable rather than re-implementing
 * the piece-count rule here. It answers with the FEN or with what is wrong. */
async function validateEditor() {
  const editor = app.editor;
  if (!editor) return;
  editor.turn = document.getElementById("editor-turn").value;
  for (const side of ["a", "b"]) {
    editor.hands[side] = {
      kits: Number(document.getElementById(`hand-${side}-kits`).value) || 0,
      cats: Number(document.getElementById(`hand-${side}-cats`).value) || 0,
    };
  }

  for (const side of ["a", "b"]) {
    const [kitten, cat] = side === "a" ? ["a", "A"] : ["b", "B"];
    const onBoard = editor.board.flat().filter((c) => c === kitten || c === cat).length;
    const total = onBoard + editor.hands[side].kits + editor.hands[side].cats;
    const cell = document.getElementById(`total-${side}`);
    cell.textContent = `${total}/8`;
    cell.classList.toggle("wrong", total !== 8);
  }

  const problem = document.getElementById("editor-error");
  try {
    const state = await api("/api/position", {
      board: editor.board, hands: editor.hands, turn: editor.turn });
    editor.fen = state.fen;
    editor.state = state;
    problem.hidden = true;
    document.getElementById("continue-here").disabled = false;
  } catch (error) {
    editor.fen = null;
    problem.textContent = error.message;
    problem.hidden = false;
    document.getElementById("continue-here").disabled = true;
  }
  renderHands({ ...app.current.state, turn: editor.turn, hands: editor.hands, isOver: false });
  document.getElementById("status").textContent = "Board editor";
  document.getElementById("fen").value = editor.fen || "";
  renderNotation();
}

async function continueFromHere() {
  const state = app.editor.state;
  leaveEditor();
  app.root = makeNode(null, state.fen, state, null);
  await goTo(app.root, { animate: false });
}

/* ---------------- wheel navigation ---------------- */

// How much accumulated scrolling counts as one move. A mouse notch is around
// 100 pixels; a trackpad sends a stream of small deltas for one flick, so they
// are added up rather than treated as a move each.
const WHEEL_STEP = 45;
// Wheel deltas can arrive in lines or pages rather than pixels.
const DELTA_SCALE = { 0: 1, 1: 16, 2: 400 };

function wireWheel() {
  const board = document.getElementById("board-wrap");
  let accumulated = 0;

  board.addEventListener("wheel", (event) => {
    event.preventDefault();          // navigate instead of scrolling the page

    const delta = event.deltaY * (DELTA_SCALE[event.deltaMode] ?? 1);
    if (delta === 0) return;
    // Reversing direction starts the count again, so a flick back the other
    // way responds immediately instead of first undoing what has built up.
    if (Math.sign(delta) !== Math.sign(accumulated)) accumulated = 0;
    accumulated += delta;
    if (Math.abs(accumulated) < WHEEL_STEP) return;

    accumulated > 0 ? forward() : back();
    accumulated = 0;
  }, { passive: false });
}

/* ---------------- settings ---------------- */

/* Settings are kept in the browser, which sometimes refuses to keep them: a
 * private window, a page opened from a file, or site data switched off. Reads
 * throw there as readily as writes do, so both go through here. Losing a
 * setting is fine; taking the page down with it is not. */
function recall(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function store(key, value) {
  try { localStorage.setItem(key, value); } catch { /* not in this browser, then */ }
}

function remember(id, apply) {
  const element = document.getElementById(id);
  const saved = recall(id);
  if (saved !== null) element.value = saved;
  const update = () => {
    apply(element.value);
    store(id, element.value);
  };
  element.addEventListener("input", update);
  element.addEventListener("change", update);
  apply(element.value);
}

function wireMenus() {
  for (const menu of document.querySelectorAll(".menu")) {
    const button = menu.querySelector(".menu-button");
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const open = menu.classList.contains("open");
      document.querySelectorAll(".menu").forEach((other) => {
        other.classList.remove("open");
        other.querySelector(".menu-button").setAttribute("aria-expanded", "false");
      });
      menu.classList.toggle("open", !open);
      button.setAttribute("aria-expanded", String(!open));
    });
    menu.querySelector(".menu-panel").addEventListener("click", (e) => e.stopPropagation());
  }
}

/* The two help pages live in the markup rather than being built here - they
 * are prose, and prose belongs in HTML. */
function wireHelp() {
  const dialog = document.getElementById("help");
  const title = document.getElementById("help-title");

  const open = (id, heading) => {
    let shown = null;
    for (const article of dialog.querySelectorAll(".help-body")) {
      article.hidden = article.id !== id;
      if (!article.hidden) shown = article;
    }
    title.textContent = heading;
    closeMenus();
    dialog.showModal();
    // Reopening it should start at the top, not where you left off reading.
    shown.scrollTop = 0;
  };

  document.getElementById("show-rules").onclick =
    () => open("help-rules", "The rules of Boop");
  document.getElementById("show-guide").onclick =
    () => open("help-guide", "Using this page");

  // Esc closes it. A modal <dialog> is supposed to do this itself, over the
  // browser's close-request path; closing it here too costs two lines and
  // does not depend on that path.
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    dialog.close();
  });

  // The backdrop belongs to the dialog element, so a click that lands on the
  // dialog itself rather than on anything inside it came from outside the box.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
}

function closeMenus() {
  document.querySelectorAll(".menu").forEach((menu) => {
    menu.classList.remove("open");
    menu.querySelector(".menu-button").setAttribute("aria-expanded", "false");
  });
}

/* ---------------- wiring ---------------- */

function main() {
  buildBoard();
  wireMenus();
  wireHelp();
  wireResize();
  wireWheel();

  document.getElementById("new-game").onclick = () => newGame(null);
  document.getElementById("toggle-editor").onclick = () =>
    (app.editor ? leaveEditor() : enterEditor());
  document.getElementById("continue-here").onclick = continueFromHere;
  document.getElementById("editor-cancel").onclick = leaveEditor;
  document.getElementById("editor-clear").onclick = clearEditorBoard;
  document.getElementById("palette-clear").onclick = clearEditorBoard;
  for (const tile of document.querySelectorAll(".palette .tile[data-brush]")) {
    tile.onclick = () => { app.editor.brush = tile.dataset.brush; paintPalette(); };
    // Right-click flips the selected colour wherever it lands - over the
    // tiles or over the board - rather than meaning something different in
    // each place.
    tile.addEventListener("contextmenu", (event) => {
      if (!app.editor) return;
      event.preventDefault();
      swapBrushColour();
    });
  }
  wireEditorPainting();
  document.getElementById("editor-turn").onchange = validateEditor;
  for (const side of ["a", "b"]) {
    for (const kind of ["kits", "cats"]) {
      document.getElementById(`hand-${side}-${kind}`).oninput = validateEditor;
    }
  }
  document.getElementById("back").onclick = back;
  document.getElementById("forward").onclick = forward;
  document.getElementById("promote").onclick = () => promoteVariation(app.current);
  document.getElementById("make-main").onclick = () => makeMainLine(app.current);
  document.getElementById("delete-branch").onclick = () => deleteFrom(app.current);
  document.getElementById("load-fen").onclick = () =>
    newGame(document.getElementById("fen").value.trim());
  document.getElementById("copy-fen").onclick = (event) =>
    copy(app.current.fen, event.target);
  document.getElementById("load-moves").onclick = loadMoves;
  document.getElementById("copy-moves").onclick = (event) =>
    copy(exportText(), event.target);

  document.getElementById("context").addEventListener("click", (event) => {
    const action = event.target.dataset.action;
    const node = app.menuNode;
    closeContext();
    if (!node || !action) return;
    if (action === "promote") promoteVariation(node);
    if (action === "make-main") makeMainLine(node);
    if (action === "delete") deleteFrom(node);
  });

  remember("board-theme", (value) => { document.body.dataset.boardTheme = value; });
  remember("piece-theme", (value) => { document.body.dataset.pieceTheme = value; });
  remember("coords", (value) => { document.body.dataset.coords = value; });
  remember("moves-format", (value) => {
    document.body.dataset.moves = value;
    if (app.root) renderNotation();
  });
  remember("board-light", (value) =>
    document.documentElement.style.setProperty("--board-shift", value));
  remember("piece-light", applyPieceColours);
  remember("colour-a", applyPieceColours);
  remember("colour-b", applyPieceColours);
  remember("speed", (value) => {
    document.documentElement.style.setProperty("--slide-ms", `${slideDuration()}ms`);
    document.documentElement.style.setProperty("--fade-ms", `${fadeDuration()}ms`);
    document.getElementById("speed-readout").textContent = `${Number(value).toFixed(2)}x`;
  });

  document.getElementById("reset-colours").onclick = () => {
    for (const side of ["a", "b"]) {
      const input = document.getElementById(`colour-${side}`);
      input.value = DEFAULT_COLOURS[side];
      store(`colour-${side}`, input.value);
    }
    const light = document.getElementById("piece-light");
    light.value = "0";
    store("piece-light", "0");
    applyPieceColours();
  };

  const variations = document.getElementById("with-variations");
  const savedVariations = recall("with-variations");
  if (savedVariations !== null) variations.checked = savedVariations === "true";
  variations.addEventListener("change", () => {
    store("with-variations", String(variations.checked));
    render();
  });

  const animate = document.getElementById("animate");
  const savedAnimate = recall("animate");
  if (savedAnimate !== null) animate.checked = savedAnimate === "true";
  app.animate = animate.checked;
  animate.addEventListener("change", () => {
    app.animate = animate.checked;
    store("animate", String(animate.checked));
  });

  const savedSize = recall("board-size");
  if (savedSize) setBoardSize(Number(savedSize));

  document.addEventListener("keydown", (event) => {
    const target = event.target;
    if (target instanceof Element && target.matches("input, textarea, select")) return;
    // While help is up the board's shortcuts are off: the arrows must not
    // step a line you cannot see, and Esc belongs to the dialog.
    if (document.getElementById("help").open) return;
    if (event.key === "ArrowLeft") back();
    if (event.key === "ArrowRight") forward();
    if (event.key === "Escape") {
      closePicker(); closeContext(); closeMenus();
      if (app.removal) { app.removal = null; render(); }
    }
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".picker") && !event.target.closest(".square")) closePicker();
    if (!event.target.closest(".context")) closeContext();
    if (!event.target.closest(".menu")) closeMenus();
  });
  document.addEventListener("contextmenu", (event) => {
    if (!event.target.closest(".ply")) closeContext();
  });

  newGame(null);
}

main();
