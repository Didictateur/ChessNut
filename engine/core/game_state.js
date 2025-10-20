import Board, { Piece } from './board.js';
import Team from './team.js';
import Stack from './stack.js';
import PieceColor from './board.js';
import Piece from './board.js';

class GameState {
    constructor() {
        /** @type {Board} */
        this.board = new Board(8, 8);
        /** @type {Stack} */
        this.stack = new Stack();
        /** @type {Team} */
        this.whiteTeam = new Team("white");
        /** @type {Team} */
        this.blackTeam = new Team("black");
        /** @type {number} */
        this.turn = 0;
				/** @type {Piece|null} */
				this.whiteSelectedPiece = null;
				/** @type {Piece|null} */
				this.blackSelectedPiece = null;
    }

    /**
     * @returns {void}
     */
    nextTurn() {
        this.turn = 1 - this.turn;
    }

    /**
     * @param {PieceColor} color
     * @returns {boolean}
     */
    hasHisKing(color) {
        const team = color === PieceColor.WHITE ? this.whiteTeam : this.blackTeam;
        return team.hasKing();
    }

		/**
		 * @param {PieceColor}
		 * @returns {Array<>}
		 */
		getMoves(team) {
			if (team == WHITE && this.whiteSelectedPiece != null) {
				if (this.whiteSelectedPiece.priorityMovements.length > 0) {
					return this.whiteSelectedPiece.priorityMovements.flatmap((m) => m.moves());
				} else {
					return this.whiteSelectedPiece.movements.flatMap((m) => m.moves());
				}
			} else if (team == BLACK && this.blackSelectedPiece != null) {
				if (this.blackSelectedPiece.priorityMovements.length > 0) {
					return this.blackSelectedPiece.priorityMovements.flatmap((m) => m.moves());
				} else {
					return this.blackSelectedPiece.movements.flatMap((m) => m.moves());
				}
			} else {
				return [];
			}
		}

		/**
		 * @param {number}
		 * @param {number}
		 * @param {PieceColor}
		 * @returns {boolean}
		 */
		click(x, y, team) {
			selectedPiece = this.board.grid[x][y];
			// White team
			if (team == WHITE) {
				// one empty cell
				if (this.whiteSelectedPiece == null) {
					this.whiteSelectedPiece = this.board.grid[x][y].piece;
				// previous one was black
				} else if (this.whiteSelectedPiece.color == BLACK) {
					this.whiteSelectedPiece = this.board.grid[x][y].piece;
				// select a white piece
				} else if (selectedPiece.color == WHITE) {
					this.whiteSelectedPiece = this.board.grid[x][y].piece;
				// possible move
				} else {
					// authorized move
					if (this.getMoves(team).filter(({x_, y_, _}) => x == x_ && y == y_).length > 0) {
						if (selectedPiece != null) {
							this.whiteTeam.capture.push(selectedPiece);
						}
						this.board.grid[x][y] = this.whiteSelectedPiece;
						this.board.grid[this.whiteSelectedPiece.x][this.whiteSelectedPiece.y] = null;
						this.whiteSelectedPiece.x = x;
						this.whiteSelectedPiece.y = y;
						return true;
					} else {
						this.whiteSelectedPiece = this.board.grid[x][y].piece;
					}
				}

			// black team
			} else {
				// one empty cell
				if (this.blackSelectedPiece == null) {
					this.blackSelectedPiece = this.board.grid[x][y].piece;
				// previous one was white
				} else if (this.blackSelectedPiece.color == WHITE) {
					this.blackSelectedPiece = this.board.grid[x][y].piece;
				// select a black piece
				} else if (selectedPiece.color == BLACK) {
					this.blackSelectedPiece = this.board.grid[x][y].piece;
				// possible move
				} else {
					// authorized move
					if (this.getMoves(team).filter(({x_, y_, _}) => x == x_ && y == y_).length > 0) {
						if (selectedPiece != null) {
							this.blackTeam.capture.push(selectedPiece);
						}
						this.board.grid[x][y] = this.blackSelectedPiece;
						this.board.grid[this.blackSelectedPiece.x][this.blackSelectedPiece.y] = null;
						this.blackSelectedPiece.x = x;
						this.blackSelectedPiece.y = y;
						return true;
					} else {
						this.blackSelectedPiece = this.board.grid[x][y].piece;
					}
				}
			}

			// no move done
			return false;
		}
}

export default GameState;
