"use strict";

/* The rules of Boop, ported from main.py.
 *
 * This file is the whole reason the standalone app can be static: the served
 * app asks a Python process what is legal, and here the browser works it out
 * itself. It is a deliberate transliteration rather than a rewrite - same
 * order of operations, same move encodings, same FEN - so the two can be
 * checked against each other. selftest.html does exactly that, replaying games
 * recorded from the Python engine and comparing every position and every set
 * of legal moves.
 *
 * Moves are arrays rather than Python tuples:
 *
 *   ["ad", [i, j], "kit"|"cat"]        place a piece from hand
 *   ["rm", [i, j], "ad", [k, l]]       empty hand: graduate (i,j), place a cat on (k,l)
 *   ["rm", [i, j], [k, l], [m, n]]     graduate a line of three
 *   ["pass"]                           no line was made
 *
 * Arrays compare by identity in JavaScript, so anywhere Python wrote
 * `move in legal_moves` this uses moveKey() and a string compare.
 */

const SIZE = 6;
const DIRECTIONS = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1], [0, 1],
  [1, -1], [1, 0], [1, 1],
];

function moveKey(move) {
  return JSON.stringify(move);
}

function emptyBoard() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill("."));
}

class BoopGame {
  constructor(fen) {
    this.board = emptyBoard();
    this.aHand = { kits: 8, cats: 0 };
    this.bHand = { kits: 8, cats: 0 };
    this.turn = "a";
    this.mode = "play";      // "play" to place a piece, "trip" to resolve a line
    this.isOver = false;
    this.winner = null;
    if (fen !== undefined && fen !== null && fen !== "") this.parseFen(fen);
  }

  parseFen(fen) {
    const parts = String(fen).trim().split("-");
    if (parts.length !== 4) throw new Error(`Not a position: ${fen}`);
    const [boardPart, aHandPart, bHandPart, turnPart] = parts;

    const rows = boardPart.split("/");
    if (rows.length !== SIZE) throw new Error("A board has six rows");
    this.board = emptyBoard();
    rows.forEach((row, i) => {
      let j = 0;
      for (const character of row) {
        if (character >= "0" && character <= "9") {
          j += Number(character);
        } else {
          if (!"aAbB".includes(character)) {
            throw new Error(`Not a piece: ${character}`);
          }
          if (j >= SIZE) throw new Error("A board row is six squares wide");
          this.board[i][j] = character;
          j += 1;
        }
      }
      if (j !== SIZE) throw new Error("A board row is six squares wide");
    });

    const readHand = (text) => {
      if (!/^\d\d$/.test(text)) throw new Error(`Not a hand: ${text}`);
      return { kits: Number(text[0]), cats: Number(text[1]) };
    };
    this.aHand = readHand(aHandPart);
    this.bHand = readHand(bHandPart);

    if (!turnPart || !"ab".includes(turnPart[0])) {
      throw new Error(`Not a side to move: ${turnPart}`);
    }
    this.turn = turnPart[0];
    this.mode = String(fen).endsWith("p") ? "play" : "trip";
  }

  copy() {
    const other = new BoopGame();
    other.board = this.board.map((row) => row.slice());
    other.aHand = { ...this.aHand };
    other.bHand = { ...this.bHand };
    other.turn = this.turn;
    other.mode = this.mode;
    other.isOver = this.isOver;
    other.winner = this.winner;
    return other;
  }

  hand(side) {
    return side === "a" ? this.aHand : this.bHand;
  }

  symbols(side) {
    return side === "a" ? ["a", "A"] : ["b", "B"];
  }

  fen() {
    const rows = this.board.map((row) => {
      let text = "";
      let empty = 0;
      for (const cell of row) {
        if (cell === ".") { empty += 1; continue; }
        if (empty) { text += String(empty); empty = 0; }
        text += cell;
      }
      return text + (empty ? String(empty) : "");
    });
    return (
      rows.join("/") +
      `-${this.aHand.kits}${this.aHand.cats}` +
      `-${this.bHand.kits}${this.bHand.cats}` +
      `-${this.turn}${this.mode === "play" ? "p" : "t"}`
    );
  }

  getMoves() {
    return this.mode === "play" ? this.getPlayMoves() : this.getTripMoves();
  }

  getPlayMoves() {
    const moves = [];
    const [kit, cat] = this.symbols(this.turn);
    const hand = this.hand(this.turn);

    // With nothing left in hand, a turn is instead: graduate one of your own
    // pieces and place it, as a cat, anywhere free - including the square it
    // came from.
    if (hand.kits === 0 && hand.cats === 0) {
      for (let i = 0; i < SIZE; i++) {
        for (let j = 0; j < SIZE; j++) {
          if (this.board[i][j] !== kit && this.board[i][j] !== cat) continue;
          for (let k = 0; k < SIZE; k++) {
            for (let l = 0; l < SIZE; l++) {
              if (this.board[k][l] === "." || (i === k && j === l)) {
                moves.push(["rm", [i, j], "ad", [k, l]]);
              }
            }
          }
        }
      }
      return moves;
    }

    for (let i = 0; i < SIZE; i++) {
      for (let j = 0; j < SIZE; j++) {
        if (this.board[i][j] !== ".") continue;
        if (hand.kits > 0) moves.push(["ad", [i, j], "kit"]);
        if (hand.cats > 0) moves.push(["ad", [i, j], "cat"]);
      }
    }
    return moves;
  }

  getTripMoves() {
    const moves = [];
    const [kit, cat] = this.symbols(this.turn);
    const mine = (i, j) => this.board[i][j] === kit || this.board[i][j] === cat;

    for (let i = 0; i < SIZE; i++) {
      for (let j = 0; j < SIZE; j++) {
        if (!mine(i, j)) continue;
        if (j <= 3 && mine(i, j + 1) && mine(i, j + 2)) {
          moves.push(["rm", [i, j], [i, j + 1], [i, j + 2]]);
        }
        if (i <= 3 && mine(i + 1, j) && mine(i + 2, j)) {
          moves.push(["rm", [i, j], [i + 1, j], [i + 2, j]]);
        }
        if (i <= 3 && j <= 3 && mine(i + 1, j + 1) && mine(i + 2, j + 2)) {
          moves.push(["rm", [i, j], [i + 1, j + 1], [i + 2, j + 2]]);
        }
        if (i >= 2 && j <= 3 && mine(i - 1, j + 1) && mine(i - 2, j + 2)) {
          moves.push(["rm", [i, j], [i - 1, j + 1], [i - 2, j + 2]]);
        }
      }
    }
    if (moves.length === 0) moves.push(["pass"]);
    return moves;
  }

  /* A turn is two plies: place a piece, then resolve any line it made. Only
   * after the second does the turn pass over. */
  makeMove(move, checkLegal = true) {
    if (this.isOver) throw new Error("Game is over. No more moves can be made.");
    if (checkLegal) {
      const wanted = moveKey(move);
      if (!this.getMoves().some((legal) => moveKey(legal) === wanted)) {
        throw new Error(`Illegal move: ${wanted}`);
      }
    }

    if (this.mode === "play") {
      this._makePlayMove(move);
      this.mode = "trip";
    } else {
      this._makeTripMove(move);
      this.mode = "play";
      this.turn = this.turn === "a" ? "b" : "a";
    }
  }

  _makePlayMove(move) {
    const [kit, cat] = this.symbols(this.turn);
    const hand = this.hand(this.turn);

    if (move[0] === "rm") {
      const [i, j] = move[1];
      this.board[i][j] = ".";
      const [k, l] = move[3];
      this.board[k][l] = cat;
      this._updateBoop([k, l], "cat");
    } else if (move[0] === "ad") {
      const [i, j] = move[1];
      if (move[2] === "kit") {
        this.board[i][j] = kit;
        hand.kits -= 1;
      } else {
        this.board[i][j] = cat;
        hand.cats -= 1;
      }
      this._updateBoop([i, j], move[2]);
    }

    if (this._checkWin()) {
      this.isOver = true;
      this.winner = this.turn;
    }
  }

  _checkWin() {
    const cat = this.turn === "a" ? "A" : "B";
    const is = (i, j) => this.board[i][j] === cat;

    for (let i = 0; i < SIZE; i++) {
      for (let j = 0; j < SIZE; j++) {
        if (!is(i, j)) continue;
        if (j <= 3 && is(i, j + 1) && is(i, j + 2)) return true;
        if (i <= 3 && is(i + 1, j) && is(i + 2, j)) return true;
        if (i <= 3 && j <= 3 && is(i + 1, j + 1) && is(i + 2, j + 2)) return true;
        if (i >= 2 && j <= 3 && is(i - 1, j + 1) && is(i - 2, j + 2)) return true;
      }
    }

    let cats = 0;
    for (const row of this.board) for (const cell of row) if (cell === cat) cats += 1;
    return cats >= 8;
  }

  /* Placing a piece pushes every neighbour one square directly away, if the
   * square beyond is free. A piece pushed off the edge goes back to its
   * owner's hand. Kittens cannot push cats.
   *
   * Resolving the eight directions in order is safe: a pushed piece travels
   * from distance one to distance two of the placement, only distance-one
   * squares are ever sources, and the eight destinations are distinct - so no
   * push can enable or block another. */
  _updateBoop(pos, type) {
    const [i, j] = pos;
    for (const [di, dj] of DIRECTIONS) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || ni >= SIZE || nj < 0 || nj >= SIZE) continue;
      const piece = this.board[ni][nj];
      if (piece === ".") continue;
      if (type === "kit" && (piece === "A" || piece === "B")) continue;

      const ti = ni + di;
      const tj = nj + dj;
      if (ti >= 0 && ti < SIZE && tj >= 0 && tj < SIZE) {
        if (this.board[ti][tj] === ".") {
          this.board[ti][tj] = piece;
          this.board[ni][nj] = ".";
        }
      } else {
        if (piece === "a") this.aHand.kits += 1;
        else if (piece === "A") this.aHand.cats += 1;
        else if (piece === "b") this.bHand.kits += 1;
        else if (piece === "B") this.bHand.cats += 1;
        this.board[ni][nj] = ".";
      }
    }
  }

  _makeTripMove(move) {
    if (move[0] === "win") {
      this.isOver = true;
      this.winner = this.turn;
      return;
    }
    if (move[0] === "pass") return;

    // Every piece in the line comes back as a cat, whatever it was.
    for (const [i, j] of move.slice(1)) {
      const piece = this.board[i][j];
      if (piece === "a" || piece === "A") this.aHand.cats += 1;
      else if (piece === "b" || piece === "B") this.bHand.cats += 1;
      this.board[i][j] = ".";
    }
  }

  isGameOver() {
    return this.isOver;
  }
}

const STANDARD_START = new BoopGame().fen();
