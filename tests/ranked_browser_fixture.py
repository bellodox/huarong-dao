"""Replay known paths through trusted browser pointer events against loopback sessions only."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATHS = json.loads((ROOT / 'tests/fixtures/paths.json').read_text())


def complete_ranked(page, layout='rear_guard', extra_pairs=0):
    """Use real session endpoints and the normal pointer handler, never inject a witness."""
    path = next(row for row in PATHS if row['l'] == layout)
    page.evaluate('(layout) => selectLayout(GAME_LAYOUTS.findIndex(row => row.id === layout))', layout)
    page.wait_for_function('window.hdRanked && !hdRanked.isPending()')
    moves = path['m']
    if extra_pairs:
        pair = page.evaluate("""() => {
            const ids=['CC','ZY','ZF','MC','HZ','GY','S1','S2','S3','S4'];
            const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
            const grid=buildGrid(currentState);
            for(const id of ids)for(let d=0;d<4;d++){
                const direction=DIRECTIONS[d];
                if(canMovePiece(id,currentState,direction.dx,direction.dy,grid))
                    return alphabet[ids.indexOf(id)*4+d]+alphabet[ids.indexOf(id)*4+(d+2)%4];
            }
        }""")
        moves = pair * extra_pairs + moves
    ids = ['CC', 'ZY', 'ZF', 'MC', 'HZ', 'GY', 'S1', 'S2', 'S3', 'S4']
    alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    for index, symbol in enumerate(moves):
        piece, direction = divmod(alphabet.index(symbol), 4)
        dx, dy = [(0, -1), (1, 0), (0, 1), (-1, 0)][direction]
        bounds = page.locator('#tile-' + ids[piece]).bounding_box()
        board = page.locator('#board').bounding_box()
        x, y = bounds['x'] + bounds['width'] / 2, bounds['y'] + bounds['height'] / 2
        page.mouse.move(x, y)
        page.mouse.down()
        page.mouse.move(x + dx * board['width'] / 4 * .6, y + dy * board['height'] / 5 * .6)
        page.mouse.up()
        assert page.evaluate('userMovesCount') == index + 1, (layout, index, symbol)
        page.wait_for_timeout(180)
    page.wait_for_function('runEvidence?.witness?.proof && roundFinalized && !assistedRun && !solverEnabled')
    assert page.evaluate('runEvidence.m') == moves
    return moves
