"""Loopback production-disabled pointer replay of a public, known 82-move path.
Automation follows fixture moves through mouse gestures, not game move/solver calls.
This establishes UI input behavior, not human play or live publication.
"""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

OUTPUT = Path(__file__).resolve().parent
ROOT = OUTPUT.parents[1]
path = next(item for item in json.loads((ROOT / 'tests/fixtures/paths.json').read_text()) if item['l'] == 'rear_guard')
piece_ids = ['CC', 'ZY', 'ZF', 'MC', 'HZ', 'GY', 'S1', 'S2', 'S3', 'S4']
alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    try:
        context = browser.new_context(locale='en-US', viewport={'width': 390, 'height': 844})
        page = context.new_page()
        errors, score_posts = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('request', lambda request: score_posts.append(request.url) if request.method == 'POST' and '/api/score' in request.url else None)
        page.route('https://**', lambda route: route.abort())
        page.goto('http://127.0.0.1:8787/', wait_until='networkidle')
        page.locator('#btn-game-story-done').click()
        page.locator('#cookie-reject').click()
        assert page.evaluate('HUARONG_PUBLIC_ENABLED === false && !solverEnabled')
        layout_index = page.evaluate("GAME_LAYOUTS.findIndex(layout => layout.id === 'rear_guard')")
        page.locator('#btn-levels-menu').click()
        page.locator('#levels-list > div').nth(layout_index).click()
        page.wait_for_timeout(200)
        assert page.evaluate("GAME_LAYOUTS[currentLayoutIdx].id === 'rear_guard'")
        page.screenshot(path=str(OUTPUT / 'pointer-start.png'), full_page=True)
        for index, symbol in enumerate(path['m']):
            piece, direction = divmod(alphabet.index(symbol), 4)
            dx, dy = [(0, -1), (1, 0), (0, 1), (-1, 0)][direction]
            bounds = page.locator('#tile-' + piece_ids[piece]).bounding_box()
            board = page.locator('#board').bounding_box()
            x, y = bounds['x'] + bounds['width'] / 2, bounds['y'] + bounds['height'] / 2
            page.mouse.move(x, y)
            page.mouse.down()
            page.mouse.move(x + dx * board['width'] / 4 * 0.6, y + dy * board['height'] / 5 * 0.6)
            page.mouse.up()
            assert page.evaluate('userMovesCount') == index + 1, (index, symbol)
            page.wait_for_timeout(180)
        assert page.evaluate('roundFinalized && !assistedRun && !solverEnabled && runEvidence.m.length === 82')
        assert page.evaluate('runEvidence.m') == path['m']
        page.locator('#player-name-input').fill('PointerPlay')
        page.locator('#btn-confirm-gate').click()
        saved = page.evaluate('JSON.parse(localStorage.getItem(SCORE_STORE_V2_KEY))')
        assert saved['owner'] == 'PointerPlay' and saved['best']['rear_guard'][1] == 82
        assert any(row['m'] == path['m'] for row in saved['evidence'].values())
        assert page.evaluate("nameLocked && !localStorage.getItem('huarong_rod_identity_v1')")
        page.screenshot(path=str(OUTPUT / 'pointer-victory.png'), full_page=True)
        page.reload(wait_until='networkidle')
        assert page.evaluate("nameLocked && nickname === 'PointerPlay' && GAME_LAYOUTS[currentLayoutIdx].id === 'training'")
        assert page.evaluate("bestForLayout('rear_guard')[1] === 82")
        assert not score_posts and not errors, (score_posts, errors)
        result = {'fixture': True, 'live': False, 'pointer_moves': 82, 'local_score_moves': 82, 'exact_path': True, 'solver_enabled': False, 'assisted': False, 'reload_persisted': True, 'player_identity_created': False, 'score_posts': 0, 'page_errors': errors}
        (OUTPUT / 'pointer-result.json').write_text(json.dumps(result, indent=2))
        print('PASS', json.dumps(result), flush=True)
        context.close()
    finally:
        browser.close()
