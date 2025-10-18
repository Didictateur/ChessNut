import Board from './board.js';
import Team from './team.js';
import Stack from './stack.js';

class GameState {
    constructor() {
        /** @type {Board} */
        this.board = new Board(8, 9);
        /** @type {Stack} */
        this.stack = new Stack();
        /** @type {Team} */
        this.whiteTeam = new Team("white");
        /** @type {Team} */
        this.blackTeam = new Team("black");
        /** @type {number} */
        this.turn = 0;
    }

    /**
     * @returns {Board}
     */
    getBoard() {
        return this.board;
    }

    /**
     * @returns {Team}
     */
    getWhiteTeam() {
        return this.whiteTeam;
    }

    /**
     * @returns {Team}
     */
    getBlackTeam() {
        return this.blackTeam;
    }

    /**
     * @returns {number}
     */
    getTurn() {
        return this.turn;
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
}

export default GameState;