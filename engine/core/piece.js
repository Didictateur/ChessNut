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
     */
    constructor(color, type) {
        /** @type {PieceColor} */
        this.color = color;
        /** @type {PieceType} */
        this.type = type;
        /** @type {boolean} */
        this.hasMoved = false;
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