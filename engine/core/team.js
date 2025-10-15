import Piece from './piece.js';
import PieceColor from './piece.js';
import Hand from './hand.js';

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
        /** @type {Hand} */
        this.hand = new this.hand();
        /** @type {boolean} */
        this.hasMadeAction = false;
    }

    /**
     * @returns {boolean}
     */
    hasKing() {
        return this.king !== null;
    }
}