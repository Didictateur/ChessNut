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
     */
    constructor(color, type, movements) {
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
    }

    /**
     * @returns {PieceColor}
     */
    getColor() {
        return this.color;
    }

    /**
     * @returns {PieceType}
     */
    getType() {
        return this.type;
    }
}