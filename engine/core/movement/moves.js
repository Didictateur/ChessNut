import { generateLinearMoves } from './generateMoves.js';

// basic moves
class RookMove {
    /**
     * Return possible moves for a rook-like piece from `from` on the given `board`.
     * The move format is { x, y, capture: boolean }
     *
     * ctx: { board, from: {x,y}, piece, allowRing }
     */
    static moves(ctx) {
        const orthogonals = [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
        ];

        return generateLinearMoves({
            board: ctx.board,
            from: ctx.from,
            piece: ctx.piece,
            directions: orthogonals,
						allowRing: ctx.allowRing
        });
    }
}

class BishopMove {
    /**
     * Return possible moves for a bishop-like piece from `from` on the given `board`.
     * The move format is { x, y, capture: boolean }
     * 
     * ctx: { board, from: {x,y}, piece }
     */
    static moves(ctx) {
        const diagonals = [
            [1, 1],
            [1, -1],
            [-1, 1],
            [-1, -1],
        ];

        return generateLinearMoves({
            board: ctx.board,
            from: ctx.from,
            piece: ctx.piece,
            directions: diagonals,
						allowRing: ctx.allowRing
        });
    }
}

class KnightMove {
    /**
     * Return possible moves for a knight-like piece from `from` on the given `board`.
     * The move format is { x, y, capture: boolean }
     *
     * ctx: { board, from: {x,y}, piece }
     */
    static moves(ctx) {
        const knightMoves = [
            [2, 1], [2, -1], [-2, 1], [-2, -1],
            [1, 2], [1, -2], [-1, 2], [-1, -2],
        ];

        return generateLinearMoves({
            board: ctx.board,
            from: ctx.from,
            piece: ctx.piece,
            directions: knightMoves,
            maxSteps: 1,
            allowEmpty: true,
            allowCapture: true,
						allowRing: ctx.allowRing
        });

    }
}

class QueenMove {
    /**
     * Return possible moves for a queen-like piece from `from` on the given `board`.
     * The move format is { x, y, capture: boolean }
     *
     * ctx: { board, from: {x,y}, piece }
     */
    static moves(ctx) {
        const directions = [
            [1, 0], [-1, 0], [0, 1], [0, -1], // orthogonals
            [1, 1], [1, -1], [-1, 1], [-1, -1], // diagonals
        ];

        return generateLinearMoves({
            board: ctx.board,
            from: ctx.from,
            piece: ctx.piece,
            directions: directions,
						allowRing: ctx.allowRing
        });
    }
}

class KingMove {
    /**
     * Return possible moves for a king-like piece from `from` on the given `board`.
     * The move format is { x, y, capture: boolean }
     *
     * ctx: { board, from: {x,y}, piece }
     */
    static moves(ctx) {
        const directions = [
            [1, 0], [-1, 0], [0, 1], [0, -1], // orthogonals
            [1, 1], [1, -1], [-1, 1], [-1, -1], // diagonals
        ];

        return generateLinearMoves({
            board: ctx.board,
            from: ctx.from,
            piece: ctx.piece,
            directions: directions,
            maxSteps: 1,
						allowRing: ctx.allowRing
        });
    }
}

class PawnMove {
    /**
     * Return possible moves for a pawn-like piece from `from` on the given `board`.
     * The move format is { x, y, capture: boolean }
     *
     * ctx: { board, from: {x,y}, piece }
     */
    static moves(ctx) {
        const color = ctx.piece.getColor();
        const forward = (color === 'white') ? -1 : 1; // assuming y=0 is top

        const moves = [];
        const w = ctx.board.getWidth();
        const h = ctx.board.getHeight();
        const x = ctx.from.x;
        const y = ctx.from.y;

        // Forward move
        if (y + forward >= 0 && y + forward < h) {
            const forwardCell = ctx.board.getCell(x, y + forward);
            if (forwardCell?.piece == null) {
                moves.push({ x: x, y: y + forward, capture: false });

                // Double step from starting position
                const startingRow = (color === 'white') ? h - 2 : 1;
                if (!ctx.piece.hasMoved) {
                    const doubleForwardCell = ctx.board.getCell(x, y + 2 * forward);
                    if (doubleForwardCell?.piece == null) {
                        moves.push({ x: x, y: y + 2 * forward, capture: false });
                    }
                }
                
            }
        }

        // Captures
        for (const dx of [-1, 1]) {
            if (x + dx >= 0 && x + dx < w && y + forward >= 0 && y + forward < h) {
                const diagCell = ctx.board.getCell(x + dx, y + forward);
                const target = diagCell?.piece ?? null;
                if (target != null && target.getColor() !== color) {
                    moves.push({ x: x + dx, y: y + forward, capture: true });
                }
            }
        }

        return moves;
    }
}

export { RookMove, BishopMove, KnightMove, QueenMove, KingMove, PawnMove };
