"use strict";

/* What the server used to do, done in the page.
 *
 * The served app talks to FastAPI over fetch; this stands in for it with the
 * same call signature and the same shapes going in and out, so the interface
 * code is identical in both versions. `api(path, body)` stays async and still
 * throws an Error carrying the message the server would have put in `detail`.
 *
 * Ported from webapp/server.py.
 */

const PIECES_PER_PLAYER = 8;

function fail(message) {
  throw new Error(message);
}

function loadPosition(fen) {
  if (!fen) return new BoopGame();
  try {
    return new BoopGame(fen);
  } catch (error) {
    fail(`Could not read that FEN: ${error.message}`);
  }
  return null;
}

function describeMove(game, move) {
  const described = { move, kind: move[0] };
  if (move[0] === "pass") return described;

  if (isTripMove(move)) {
    described.kind = "graduate";
    described.squares = move.slice(1).map((position) => squareName(...position));
    described.label = described.squares.join("");
    described.pieces = move.slice(1).map(([i, j]) => game.board[i][j]);
    return described;
  }

  described.token = placementToken(move);
  if (move[0] === "ad") {
    described.kind = "place";
    described.square = squareName(...move[1]);
    described.piece = move[2];
  } else {
    described.kind = "graduate_place";
    described.square = squareName(...move[3]);
    described.source = squareName(...move[1]);
    described.piece = "cat";
  }
  return described;
}

function stateOf(game, token = null) {
  const moves = game.isGameOver() ? [] : game.getMoves();
  return {
    fen: game.fen(),
    board: game.board.map((row) => row.slice()),
    hands: { a: { ...game.aHand }, b: { ...game.bHand } },
    turn: game.turn,
    mode: game.mode,
    isOver: game.isOver,
    winner: game.winner,
    legal: moves.map((move) => describeMove(game, move)),
    token,
  };
}

/* A turn is two plies. Resolve the second one here whenever there is nothing
 * to decide - no line, or exactly one - and stop to ask only when the player
 * has a real choice between lines. */
function resolvePlacement(game, placement) {
  game.makeMove(placement, true);
  let token = placementToken(placement);

  if (game.isGameOver()) return stateOf(game, `${token}#`);

  const options = game.getMoves().filter(isTripMove);
  if (options.length === 0) {
    game.makeMove(["pass"], false);
    return stateOf(game, token);
  }
  if (options.length === 1) {
    token += graduationSuffix(options[0]);
    game.makeMove(options[0], false);
    if (game.isGameOver()) token += "#";
    return stateOf(game, token);
  }
  return stateOf(game, null);
}

function buildFenFromSetup(setup) {
  const board = setup.board;
  if (!Array.isArray(board) || board.length !== 6 || board.some((row) => row.length !== 6)) {
    fail("The board must be 6 by 6");
  }
  if (setup.turn !== "a" && setup.turn !== "b") {
    fail("Whose turn it is must be 'a' or 'b'");
  }

  const rows = board.map((row) => {
    let text = "";
    let empty = 0;
    for (const cell of row) {
      if (![".", "a", "A", "b", "B"].includes(cell)) fail(`Not a piece: '${cell}'`);
      if (cell === ".") { empty += 1; continue; }
      if (empty) { text += String(empty); empty = 0; }
      text += cell;
    }
    return text + (empty ? String(empty) : "");
  });

  const counts = {};
  for (const side of ["a", "b"]) {
    const [kitten, cat] = side === "a" ? ["a", "A"] : ["b", "B"];
    const hand = (setup.hands || {})[side] || {};
    const kits = Number(hand.kits);
    const cats = Number(hand.cats);
    if (!Number.isFinite(kits) || !Number.isFinite(cats)) {
      fail(`Player ${side}'s hand must be numbers`);
    }
    if (kits < 0 || cats < 0) fail(`Player ${side} cannot hold a negative number`);

    const onBoard = board
      .flat()
      .filter((cell) => cell === kitten || cell === cat).length;
    const total = onBoard + kits + cats;
    if (total !== PIECES_PER_PLAYER) {
      const name = side === "a" ? "Orange" : "Grey";
      fail(
        `${name} has ${total} pieces; each player must have exactly ` +
        `${PIECES_PER_PLAYER} counting the board and their hand`);
    }
    counts[side] = [kits, cats];
  }

  return (
    rows.join("/") +
    `-${counts.a[0]}${counts.a[1]}` +
    `-${counts.b[0]}${counts.b[1]}` +
    `-${setup.turn}p`
  );
}

/* The same routes the served app calls, answered locally. Async so the calling
 * code does not have to know which version it is running in. */
async function api(path, body) {
  switch (path) {
    case "/api/state":
      return stateOf(loadPosition(body.fen));

    case "/api/position":
      return stateOf(loadPosition(buildFenFromSetup(body)));

    case "/api/play": {
      const game = loadPosition(body.fen);
      if (game.isGameOver()) fail("The game is already over");

      const wanted = moveKey(body.move);
      if (!game.getMoves().some((legal) => moveKey(legal) === wanted)) {
        fail("That move is not legal here");
      }

      if (game.mode === "trip") {
        game.makeMove(body.move, false);
        const suffix = graduationSuffix(body.move);
        return { ...stateOf(game, suffix), graduationSuffix: suffix };
      }
      return resolvePlacement(game, body.move);
    }

    case "/api/replay": {
      const [tagged, text] = extractSetup(body.moves);
      const tokens = splitTokens(text);
      const game = replayTokens(tokens, body.fen || tagged || undefined);
      return { ...stateOf(game), tokens };
    }

    case "/api/tree": {
      const [tagged, text] = extractSetup(body.moves);
      return parseTree(text, body.fen || tagged || undefined).asObject();
    }

    default:
      fail(`No such route: ${path}`);
      return null;
  }
}
