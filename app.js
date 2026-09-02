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
 * visited. Everything that moves around the tree goes through here. */
async function goTo(node) {
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
  render();
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

/* Which piece slid where, comparing two boards.
 *
 * A boop pushes a neighbour of the placement one square directly away, so a
 * piece that vanished from X and appeared at X + direction moved there. Only
 * squares adjacent to the placement can be sources, which keeps this
 * unambiguous. */
function slides(before, after, placedAt) {
  if (!placedAt) return [];
  const [pr, pc] = placedAt;
  const moved = [];
  for (const dr of [-1, 0, 1]) {
    for (const dc of [-1, 0, 1]) {
      if (!dr && !dc) continue;
      const fromRow = pr + dr, fromColumn = pc + dc;
      const toRow = fromRow + dr, toColumn = fromColumn + dc;
      if (fromRow < 0 || fromRow > 5 || fromColumn < 0 || fromColumn > 5) continue;
      if (toRow < 0 || toRow > 5 || toColumn < 0 || toColumn > 5) continue;
      const piece = before[fromRow][fromColumn];
      if (piece === "." ) continue;
      if (after[fromRow][fromColumn] === "." && after[toRow][toColumn] === piece) {
        moved.push({ to: [toRow, toColumn], dr, dc });
      }
    }
  }
  return moved;
}

function slideDuration() {
  const speed = Number(document.getElementById("speed").value) || 1;
  return Math.round(200 / speed);
}

function animateSlides(moved) {
  if (!moved.length) return;
  const duration = slideDuration();
  const step = document.querySelector(".square").getBoundingClientRect().width + 3;
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

function render(options = {}) {
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
      "playable", "highlight", "last", "source", "selected", "target");
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

  if (options.slid && app.animate) animateSlides(options.slid);
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
  const before = (app.pending ? app.pending.state : app.current.state).board;
  try {
    const result = await api("/api/play", {
      fen: app.pending ? app.pending.state.fen : app.current.fen,
      move: move.move,
    });
    const placedAt = squareToIndices(move.square);
    const slid = slides(before, result.board, placedAt);

    if (result.mode === "trip" && !result.isOver) {
      app.pending = { node: app.current, token: move.token, state: result };
      render({ slid });
      return;
    }
    advance(result, result.token, slid);
  } catch (error) {
    showError(error.message);
  }
}

function squareToIndices(name) {
  return name ? [6 - Number(name[1]), FILES.indexOf(name[0])] : null;
}

async function chooseGraduation(option) {
  const pending = app.pending;
  try {
    const result = await api("/api/play", { fen: pending.state.fen, move: option.move });
    const token = pending.token + result.graduationSuffix + (result.isOver ? "#" : "");
    app.current = pending.node;
    app.pending = null;
    advance(result, token, []);
  } catch (error) {
    showError(error.message);
  }
}

function advance(state, token, slid) {
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
  render({ slid });
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

function plySpan(node) {
  const span = document.createElement("span");
  span.className = "ply" + (node.id === app.current.id ? " current" : "");
  span.textContent = node.token;
  span.title = node.fen;
  span.addEventListener("click", () => goTo(node));
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
 * would shuffle moves that are not the reason the line is a variation. */
function branchPoint(node) {
  let anchor = null;
  for (let step = node; step && step.parent; step = step.parent) {
    if (step.parent.children.indexOf(step) > 0) anchor = step;
  }
  return anchor;
}

const canPromote = (node) => Boolean(branchPoint(node));
const canMakeMain = (node) => Boolean(branchPoint(node));

function promoteVariation(node) {
  const anchor = branchPoint(node);
  if (!anchor) return;
  const siblings = anchor.parent.children;
  const index = siblings.indexOf(anchor);
  siblings.splice(index, 1);
  siblings.splice(index - 1, 0, anchor);
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

function back() {
  if (app.pending) { app.pending = null; render(); return Promise.resolve(); }
  if (app.current.parent) return goTo(app.current.parent);
  return Promise.resolve();
}

function forward() {
  if (app.current.children.length) return goTo(app.current.children[0]);
  return Promise.resolve();
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
    await goTo(app.root);
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
    await goTo(last);
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
  await goTo(app.root);
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
  let busy = false;

  board.addEventListener("wheel", async (event) => {
    event.preventDefault();          // navigate instead of scrolling the page

    const delta = event.deltaY * (DELTA_SCALE[event.deltaMode] ?? 1);
    if (delta === 0) return;
    // Reversing direction starts the count again, so a flick back the other
    // way responds immediately instead of first undoing what has built up.
    if (Math.sign(delta) !== Math.sign(accumulated)) accumulated = 0;
    accumulated += delta;
    if (Math.abs(accumulated) < WHEEL_STEP) return;

    const forwards = accumulated > 0;
    accumulated = 0;
    // Moving to a node that has never been visited fetches its position, so
    // ignore further wheeling until that lands rather than jumping twice from
    // a position that is already stale.
    if (busy) return;
    busy = true;
    try {
      await (forwards ? forward() : back());
    } finally {
      busy = false;
    }
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
  remember("highlight", (value) => { document.body.dataset.highlight = value; });
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
