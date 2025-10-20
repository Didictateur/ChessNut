const PieceColor = {
    WHITE: 'WHITE',
    BLACK: 'BLACK'
};

const PieceType = {
    PAWN: 'PAWN',
    KNIGHT: 'KNIGHT',
    BISHOP: 'BISHOP',
    ROOK: 'ROOK',
    QUEEN: 'QUEEN',
    KING: 'KING'
};

class Piece {
    /**
     * @param {PieceColor} color
     * @param {PieceType} type
     * @param {Array<import('./movement/index.js').default>} movements
		 * @param {number} x
		 * @param {number} y 
     */
    constructor(color, type, movements, x, y) {
        /** @type {PieceColor} */
        this.color = color;
        /** @type {PieceType} */
        this.type = type;
        /** @type {boolean} */
        this.hasMoved = false;
        /** @type {Array<import('./movement/index.js').default>} */
        this.movements = movements;
        /** @type {Array<import('./movement/index.js').default>} */
        this.priorityMovements = [];
				/** @type {number} */
				this.x = x;
				/** @type {number} */
				this.y = y;
    }
}

export default Piece;
export { PieceColor, PieceType };
