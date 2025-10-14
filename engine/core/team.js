import Piece from './piece.js';
import PieceColor from './piece.js';

class Team {
    /**
     * @param {PieceColor} color
     * @param {Piece} king
     */
    constructor(color, king) {
        /** @type {PieceColor} */
        this.color = color;
        /** @type {Piece} */
        this.king = king;
    }

    /**
     * @returns {boolean}
     */
    hasKing() {
        return this.king !== null;
    }
}