import Cell from './cell.js';
import * as Movement from './movement/index.js';
import Piece, { PieceColor, PieceType } from './piece.js';

/**
 * Represents the game board.
 */
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
            this.setPiece(x, 1, new Piece(PieceColor.WHITE, PieceType.PAWN, [Movement.PawnMove]));
            this.setPiece(x, 6, new Piece(PieceColor.BLACK, PieceType.PAWN, [Movement.PawnMove]));
        }

        // Rooks
        this.setPiece(0, 0, new Piece(PieceColor.WHITE, PieceType.ROOK, [Movement.RookMove]));
        this.setPiece(7, 0, new Piece(PieceColor.WHITE, PieceType.ROOK, [Movement.RookMove]));
        this.setPiece(0, 7, new Piece(PieceColor.BLACK, PieceType.ROOK, [Movement.RookMove]));
        this.setPiece(7, 7, new Piece(PieceColor.BLACK, PieceType.ROOK, [Movement.RookMove]));

        // Knights
        this.setPiece(1, 0, new Piece(PieceColor.WHITE, PieceType.KNIGHT, [Movement.KnightMove]));
        this.setPiece(6, 0, new Piece(PieceColor.WHITE, PieceType.KNIGHT, [Movement.KnightMove]));
        this.setPiece(1, 7, new Piece(PieceColor.BLACK, PieceType.KNIGHT, [Movement.KnightMove]));
        this.setPiece(6, 7, new Piece(PieceColor.BLACK, PieceType.KNIGHT, [Movement.KnightMove]));

        // Bishops
        this.setPiece(2, 0, new Piece(PieceColor.WHITE, PieceType.BISHOP, [Movement.BishopMove]));
        this.setPiece(5, 0, new Piece(PieceColor.WHITE, PieceType.BISHOP, [Movement.BishopMove]));
        this.setPiece(2, 7, new Piece(PieceColor.BLACK, PieceType.BISHOP, [Movement.BishopMove]));
        this.setPiece(5, 7, new Piece(PieceColor.BLACK, PieceType.BISHOP, [Movement.BishopMove]));

        // Queens and Kings
        this.setPiece(3, 0, new Piece(PieceColor.WHITE, PieceType.QUEEN, [Movement.QueenMove]));
        this.setPiece(4, 0, new Piece(PieceColor.WHITE, PieceType.KING, [Movement.KingMove]));
        this.setPiece(3, 7, new Piece(PieceColor.BLACK, PieceType.QUEEN, [Movement.QueenMove]));
        this.setPiece(4, 7, new Piece(PieceColor.BLACK, PieceType.KING, [Movement.KingMove]));
    }
}

export default  {
    Cell,
    Movement,
    Piece,
    PieceColor,
    PieceType,
    Board
};