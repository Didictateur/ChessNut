// Utilities for movement generation
// The movement modules receive a context object with at least:
// - board: instance exposing getWidth(), getHeight(), getCell(x,y) and setPiece(x,y,piece)
// - from: { x, y }
// - piece: the moving piece (with getColor())

/**
 * Walk in linear directions (array of dx,dy) until blocked.
 * Returns an array of move objects: { x, y, capture: boolean }
 *
 * Options:
 * - maxSteps (default: Infinity)
 * - allowCapture=true
 * - allowEmpty=true
 */
export function generateLinearMoves({
	board,
	from,
	piece,
	directions,
	maxSteps = Infinity,
	allowCapture = true,
	allowEmpty = true,
	allowRing = false
}) {
    const moves = [];
    const w = board.getWidth();
    const h = board.getHeight();
    const color = piece.getColor();

    for (const [dx, dy] of directions) {
        let steps = 0;
        let x = from.x + dx;
        let y = from.y + dy;

        while (x >= 0 && x < w && y >= 0 && y < h && steps < maxSteps) {
            const cell = board.getCell(x, y);
            const target = cell?.piece ?? null;

            if (target == null) {
                if (allowEmpty) moves.push({ x, y, capture: false });
                // continue along this direction
            } else {
                // occupied
                if (target.getColor() !== color) {
                    if (allowCapture) moves.push({ x, y, capture: true });
                }
                // stop after encountering any piece
                break;
            }

            steps++;
            x += dx;
            y += dy;
        }
    }

    return moves;
}
