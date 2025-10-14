import Cell from './cell.js';

class Board {
    /**
     * @param {number} width
     * @param {number} height
     */
    constructor(width, height) {
        /** @type {number} */
        this.width = width;
        /** @type {number} */
        this.height = height;
        /** @type {Cell[][]} */
        this.grid = Array.from({ length: height }, () => Array.from({ length: width }, () => new Cell()));

        this.setupInitialPieces();
    }

    /**
     * @returns {number}
     */
    getWidth() {
        return this.width;
    }

    /**
     * @returns {number}
     */
    getHeight() {
        return this.height;
    }

    /**
     * @param {number} x
     * @param {number} y
     * @returns {Cell}
     */
    getCell(x, y) {
        return this.grid[y][x];
    }

    /**
     * @param {number} x
     * @param {number} y
     * @param {Piece|null} piece
     */
    setPiece(x, y, piece) {
        this.grid[y][x].piece = piece;
    }

    setupInitialPieces() {
        // Pawns
        for (let x = 0; x < this.width; x++) {
            this.setPiece(x, 1, new Piece(PieceColor.WHITE, PieceType.PAWN));
            this.setPiece(x, 6, new Piece(PieceColor.BLACK, PieceType.PAWN));
        }

        // Rooks
        this.setPiece(0, 0, new Piece(PieceColor.WHITE, PieceType.ROOK));
        this.setPiece(7, 0, new Piece(PieceColor.WHITE, PieceType.ROOK));
        this.setPiece(0, 7, new Piece(PieceColor.BLACK, PieceType.ROOK));
        this.setPiece(7, 7, new Piece(PieceColor.BLACK, PieceType.ROOK));

        // Knights
        this.setPiece(1, 0, new Piece(PieceColor.WHITE, PieceType.KNIGHT));
        this.setPiece(6, 0, new Piece(PieceColor.WHITE, PieceType.KNIGHT));
        this.setPiece(1, 7, new Piece(PieceColor.BLACK, PieceType.KNIGHT));
        this.setPiece(6, 7, new Piece(PieceColor.BLACK, PieceType.KNIGHT));

        // Bishops
        this.setPiece(2, 0, new Piece(PieceColor.WHITE, PieceType.BISHOP));
        this.setPiece(5, 0, new Piece(PieceColor.WHITE, PieceType.BISHOP));
        this.setPiece(2, 7, new Piece(PieceColor.BLACK, PieceType.BISHOP));
        this.setPiece(5, 7, new Piece(PieceColor.BLACK, PieceType.BISHOP));

        // Queens and Kings
        this.setPiece(3, 0, new Piece(PieceColor.WHITE, PieceType.QUEEN));
        this.setPiece(4, 0, new Piece(PieceColor.WHITE, PieceType.KING));
        this.setPiece(3, 7, new Piece(PieceColor.BLACK, PieceType.QUEEN));
        this.setPiece(4, 7, new Piece(PieceColor.BLACK, PieceType.KING));
    }
}