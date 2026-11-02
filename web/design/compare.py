"""Design check: each design frame above the site's photo of the same section (nav bar + section),
into design/_shots/cmp<frame>.png. Run design/shoot.mjs first. `python design/compare.py`"""
import os
import sys
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
S = os.path.join(HERE, '_shots')
nav = Image.open(os.path.join(S, 'nav.png')).convert('RGB')
for f in sys.argv[1:] or ['4', '1', '2', '3', '5', 'lend', 'believers', 'join', 'footer']:
    sec = Image.open(os.path.join(S, f + '.png')).convert('RGB')
    site = Image.new('RGB', (1280, 720))
    if f == 'footer':
        site.paste(sec, (0, 0))
    else:
        site.paste(sec, (0, nav.height))
        site.paste(nav, (0, 0))
    out = Image.new('RGB', (1280, 1445), (255, 0, 255))
    out.paste(Image.open(os.path.join(HERE, 'src', f + '.jpg')).convert('RGB'), (0, 0))
    out.paste(site, (0, 725))
    out.save(os.path.join(S, 'cmp' + f + '.png'))
print('compare sheets in design/_shots')
