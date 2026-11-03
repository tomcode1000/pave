"""Design check: each app frame above the site's photo of that page, into design/_shots/cmp-<frame>.png.
Called by shoot-app.mjs. `python design/compare-app.py <frame> ...`"""
import os
import sys
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
S = os.path.join(HERE, '_shots')
for f in sys.argv[1:]:
    out = Image.new('RGB', (1280, 1445), (255, 0, 255))
    src = os.path.join(HERE, 'src', f + '.jpg')
    if os.path.exists(src):
        out.paste(Image.open(src).convert('RGB'), (0, 0))
    out.paste(Image.open(os.path.join(S, f + '.png')).convert('RGB').crop((0, 0, 1280, 720)), (0, 725))
    out.save(os.path.join(S, 'cmp-' + f + '.png'))
