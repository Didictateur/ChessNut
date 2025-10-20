import Piece, { PieceColor } from './piece.js';
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
    		this.hand = new Hand();
        /** @type {boolean} */
        this.hasMadeAction = false;
				/** @type {Array<Piece>} */
				this.capture = [];
    }

    /**
     * @returns {boolean}
     */
    hasKing() {
        return this.king !== null;
    }
}

export default Team;
