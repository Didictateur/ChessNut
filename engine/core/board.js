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
            this.setPiece(x, 1, new Piece(PieceColor.WHITE, PieceType.PAWN, [Movement.PawnMove], x, 1));
            this.setPiece(x, 6, new Piece(PieceColor.BLACK, PieceType.PAWN, [Movement.PawnMove], x, 6));
        }

        // Rooks
        this.setPiece(0, 0, new Piece(PieceColor.WHITE, PieceType.ROOK, [Movement.RookMove], 0, 0));
        this.setPiece(7, 0, new Piece(PieceColor.WHITE, PieceType.ROOK, [Movement.RookMove], 7, 0));
        this.setPiece(0, 7, new Piece(PieceColor.BLACK, PieceType.ROOK, [Movement.RookMove], 0, 7));
        this.setPiece(7, 7, new Piece(PieceColor.BLACK, PieceType.ROOK, [Movement.RookMove], 7, 7));

        // Knights
        this.setPiece(1, 0, new Piece(PieceColor.WHITE, PieceType.KNIGHT, [Movement.KnightMove], 1, 0));
        this.setPiece(6, 0, new Piece(PieceColor.WHITE, PieceType.KNIGHT, [Movement.KnightMove], 6, 0));
        this.setPiece(1, 7, new Piece(PieceColor.BLACK, PieceType.KNIGHT, [Movement.KnightMove], 1, 7));
        this.setPiece(6, 7, new Piece(PieceColor.BLACK, PieceType.KNIGHT, [Movement.KnightMove], 6, 7));

        // Bishops
        this.setPiece(2, 0, new Piece(PieceColor.WHITE, PieceType.BISHOP, [Movement.BishopMove], 2, 0));
        this.setPiece(5, 0, new Piece(PieceColor.WHITE, PieceType.BISHOP, [Movement.BishopMove], 5, 0));
        this.setPiece(2, 7, new Piece(PieceColor.BLACK, PieceType.BISHOP, [Movement.BishopMove], 2, 7));
        this.setPiece(5, 7, new Piece(PieceColor.BLACK, PieceType.BISHOP, [Movement.BishopMove], 5, 7));

        // Queens and Kings
        this.setPiece(3, 0, new Piece(PieceColor.WHITE, PieceType.QUEEN, [Movement.QueenMove], 3, 0));
        this.setPiece(4, 0, new Piece(PieceColor.WHITE, PieceType.KING, [Movement.KingMove], 4, 0));
        this.setPiece(3, 7, new Piece(PieceColor.BLACK, PieceType.QUEEN, [Movement.QueenMove], 3, 7));
        this.setPiece(4, 7, new Piece(PieceColor.BLACK, PieceType.KING, [Movement.KingMove], 4, 7));
    }
}

export { Cell, Movement, Piece, PieceColor, PieceType };
export default Board;
