"use strict";

/* Move notation, ported from webapp/notation.py.
 *
 * Squares are named like a chessboard: files a-f left to right, ranks 1-6
 * bottom to top, so a1 is the bottom-left corner. The board is indexed
 * [row][column] with row 0 at the top, so rank is 6 - row.
 *
 *   Kc3            place a kitten on c3
 *   Cc3            place a cat on c3
 *   a1>Ce3         every piece is on the bed: a1 graduates onto e3 as a cat
 *   Kc1=a1b1c1     the placement completed that line, and it graduates
 *   ...#           the move won the game
 *
 * `=` echoes chess promotion, which is what graduation is. `>` reads as
 * "becomes" and is written source-first because the piece leaves a1 before the
 * cat lands on e3. The older `Ce3/a1` spelling still parses, but is never
 * written.
 */

const NOTATION_FILES = "abcdef";

function squareName(row, column) {
  return `${NOTATION_FILES[column]}${SIZE - row}`;
}

function parseSquare(name) {
  const text = String(name).trim().toLowerCase();
  if (text.length !== 2 || !NOTATION_FILES.includes(text[0]) || !/\d/.test(text[1])) {
    throw new Error(`Not a square: '${name}'`);
  }
  const rank = Number(text[1]);
  if (rank < 1 || rank > SIZE) throw new Error(`Rank out of range: '${name}'`);
  return [SIZE - rank, NOTATION_FILES.indexOf(text[0])];
}

function isTripMove(move) {
  return move[0] === "rm" && move[2] !== "ad";
}

function placementToken(move) {
  if (move[0] === "ad") {
    return (move[2] === "kit" ? "K" : "C") + squareName(...move[1]);
  }
  if (move[0] === "rm" && move[2] === "ad") {
    return `${squareName(...move[1])}>C${squareName(...move[3])}`;
  }
  throw new Error(`Not a placement: ${moveKey(move)}`);
}

function graduationSuffix(move) {
  if (move[0] === "pass") return "";
  if (!isTripMove(move)) throw new Error(`Not a graduation: ${moveKey(move)}`);
  return "=" + move.slice(1).map((position) => squareName(...position)).join("");
}

function tokenFor(placement, graduation = null, won = false) {
  let token = placementToken(placement);
  if (graduation) token += graduationSuffix(graduation);
  return token + (won ? "#" : "");
}

function parsePlacement(text, game) {
  let move;
  if (text.includes(">") || text.includes("/")) {
    let sourceText;
    let targetText;
    if (text.includes(">")) {
      [sourceText, targetText] = text.split(">");
    } else {
      // The older spelling, kept readable but never written.
      [targetText, sourceText] = text.split("/");
    }
    if (!targetText.startsWith("C")) {
      throw new Error(`A graduating placement is always a cat: '${text}'`);
    }
    move = ["rm", parseSquare(sourceText), "ad", parseSquare(targetText.slice(1))];
  } else {
    const letter = text[0];
    if (letter !== "K" && letter !== "C") throw new Error(`Expected K or C: '${text}'`);
    move = ["ad", parseSquare(text.slice(1)), letter === "K" ? "kit" : "cat"];
  }

  const wanted = moveKey(move);
  if (!game.getMoves().some((legal) => moveKey(legal) === wanted)) {
    throw new Error(`'${text}' is not legal in this position`);
  }
  return move;
}

function parseGraduation(text, game) {
  if (!text || text.length % 2) throw new Error(`Not a list of squares: '${text}'`);
  const squares = [];
  for (let index = 0; index < text.length; index += 2) {
    squares.push(parseSquare(text.slice(index, index + 2)));
  }
  const wanted = JSON.stringify(squares);
  for (const move of game.getMoves()) {
    if (isTripMove(move) && JSON.stringify(move.slice(1)) === wanted) return move;
  }
  throw new Error(`No such line to graduate: '${text}'`);
}

function parseToken(token, game) {
  const text = String(token).trim().replace(/#+$/, "");
  if (!text) throw new Error("Empty move");

  const cut = text.indexOf("=");
  const placementText = cut === -1 ? text : text.slice(0, cut);
  const graduationText = cut === -1 ? "" : text.slice(cut + 1);
  if (cut !== -1 && !graduationText) {
    throw new Error(`'${token}' promises a graduation but names no squares`);
  }

  const placement = parsePlacement(placementText, game);
  const after = game.copy();
  after.makeMove(placement, false);

  if (graduationText) return [placement, parseGraduation(graduationText, after)];

  if (!after.isGameOver()) {
    // A token with no `=` asserts that nothing graduated. If a line did form,
    // replaying it would silently pick one the writer never chose.
    if (after.getMoves().some(isTripMove)) {
      throw new Error(`'${token}' formed a line but does not say which graduates`);
    }
  }
  return [placement, null];
}

function stripVariations(text) {
  let out = "";
  let depth = 0;
  for (const character of text) {
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) out += character;
  }
  return out;
}

function splitTokens(text) {
  const tokens = [];
  for (let piece of stripVariations(text).replace(/,/g, " ").split(/\s+/)) {
    piece = piece.trim();
    if (!piece || piece.endsWith(".")) continue;
    if (/\d/.test(piece[0]) && piece.includes(".")) {
      piece = piece.slice(piece.indexOf(".") + 1).replace(/^\.+/, "");
    }
    if (piece) tokens.push(piece);
  }
  return tokens;
}

function replayTokens(tokens, fen) {
  const game = new BoopGame(fen || undefined);
  tokens.forEach((token, index) => {
    if (game.isGameOver()) {
      throw new Error(`Move ${index + 1} (${token}): the game is already over`);
    }
    let placement;
    let graduation;
    try {
      [placement, graduation] = parseToken(token, game);
    } catch (error) {
      throw new Error(`Move ${index + 1} (${token}): ${error.message}`);
    }
    game.makeMove(placement, false);
    if (!game.isGameOver()) game.makeMove(graduation || ["pass"], false);
  });
  return game;
}

/* ---------------- move lists with variations ---------------- */

function tokenise(text) {
  const spaced = text.replace(/\(/g, " ( ").replace(/\)/g, " ) ").replace(/,/g, " ");
  const tokens = [];
  for (let piece of spaced.split(/\s+/)) {
    if (piece === "(" || piece === ")") { tokens.push(piece); continue; }
    if (!piece || piece.endsWith(".")) continue;
    if (/\d/.test(piece[0]) && piece.includes(".")) {
      piece = piece.slice(piece.indexOf(".") + 1).replace(/^\.+/, "");
    }
    if (piece) tokens.push(piece);
  }
  return tokens;
}

class TreeNode {
  constructor(token, game, parent) {
    this.token = token;
    this.game = game;
    this.parent = parent;
    this.children = [];
  }

  childFor(token) {
    return this.children.find((child) => child.token === token) || null;
  }

  asObject() {
    return {
      token: this.token,
      fen: this.game.fen(),
      children: this.children.map((child) => child.asObject()),
    };
  }
}

/* A bracketed group is an alternative to the move just played, so it branches
 * from the position before it - the PGN convention. */
function parseTree(text, fen) {
  const tokens = tokenise(text);
  const root = new TreeNode(null, new BoopGame(fen || undefined), null);
  consumeTokens(tokens, 0, root, false);
  return root;
}

function consumeTokens(tokens, index, node, inside) {
  let current = node;
  while (index < tokens.length) {
    const token = tokens[index];

    if (token === ")") {
      if (!inside) throw new Error("Unbalanced brackets: a ')' with no '(' before it");
      return index + 1;
    }

    if (token === "(") {
      if (!current.parent) {
        throw new Error(
          "A variation has to follow a move, so it has something to be an alternative to");
      }
      index = consumeTokens(tokens, index + 1, current.parent, true);
      continue;
    }

    current = playInTree(current, token, index);
    index += 1;
  }

  if (inside) throw new Error("Unbalanced brackets: a '(' was never closed");
  return index;
}

function playInTree(node, token, index) {
  if (node.game.isGameOver()) {
    throw new Error(`Move ${index + 1} (${token}): the game is already over`);
  }
  let placement;
  let graduation;
  try {
    [placement, graduation] = parseToken(token, node.game);
  } catch (error) {
    throw new Error(`Move ${index + 1} (${token}): ${error.message}`);
  }

  const after = node.game.copy();
  after.makeMove(placement, false);
  if (!after.isGameOver()) after.makeMove(graduation || ["pass"], false);

  // Store the canonical spelling, so the older Ce3/a1 form and a missing #
  // land on the same branch as the app would have written it.
  const canonical = tokenFor(placement, graduation, after.isGameOver());
  const existing = node.childFor(canonical);
  if (existing) return existing;

  const child = new TreeNode(canonical, after, node);
  node.children.push(child);
  return child;
}

/* ---------------- the setup tag ---------------- */

const SETUP_PATTERN = /\[\s*FEN\s*"([^"]*)"\s*\]/i;

function setupTagFor(fen) {
  return !fen || fen === STANDARD_START ? "" : `[FEN "${fen}"]`;
}

function extractSetup(text) {
  const match = SETUP_PATTERN.exec(text);
  if (!match) return [null, text];
  const fen = match[1].trim();
  if (!fen) throw new Error("The [FEN] tag is empty");
  try {
    new BoopGame(fen);
  } catch {
    throw new Error(`The [FEN] tag is not a position: '${fen}'`);
  }
  return [fen, text.slice(0, match.index) + text.slice(match.index + match[0].length)];
}
