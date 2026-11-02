"""
Doubles the Figma exports (1280x720 JPGs in design/src) to 2560x1440 for sharp screens:
EDSR x4 super-resolution (OpenCV dnn_superres; the model files go in design/models, not in git),
then halved, which also smooths the JPEG blocks, and a light unsharp mask.
`python design/upscale.py` (from web/) -> design/src2x/<n>.png   (slow: a few minutes a frame)

Real 2x exports from Figma beat this; drop them in design/src2x with the same names instead.
"""
import os
import sys
import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SRC, OUT = os.path.join(HERE, 'src'), os.path.join(HERE, 'src2x')
TILE, PAD, K = 200, 12, 4

sr = cv2.dnn_superres.DnnSuperResImpl_create()
sr.readModel(os.path.join(HERE, 'models', 'EDSR_x4.pb'))
sr.setModel('edsr', K)


def upscale(im):
    h, w = im.shape[:2]
    out = np.zeros((h * K, w * K, 3), np.uint8)
    for y in range(0, h, TILE):
        for x in range(0, w, TILE):
            # each tile with a margin, so the seams don't show
            y0, x0 = max(0, y - PAD), max(0, x - PAD)
            y1, x1 = min(h, y + TILE + PAD), min(w, x + TILE + PAD)
            up = sr.upsample(im[y0:y1, x0:x1])
            ty, tx = (y - y0) * K, (x - x0) * K
            th, tw = (min(h, y + TILE) - y) * K, (min(w, x + TILE) - x) * K
            out[y * K:y * K + th, x * K:x * K + tw] = up[ty:ty + th, tx:tx + tw]
    return out


os.makedirs(OUT, exist_ok=True)
# every frame in design/src that has no 2x copy yet (or the names given)
todo = sys.argv[1:] or [f[:-4] for f in sorted(os.listdir(SRC)) if f.endswith('.jpg') and not os.path.exists(os.path.join(OUT, f[:-4] + '.png'))]
for name in todo:
    im = cv2.imread(os.path.join(SRC, name + '.jpg'))
    big = cv2.resize(upscale(im), None, fx=.5, fy=.5, interpolation=cv2.INTER_AREA)
    soft = cv2.GaussianBlur(big, (0, 0), 1.2)
    sharp = cv2.addWeighted(big, 1.45, soft, -.45, 0)
    cv2.imwrite(os.path.join(OUT, name + '.png'), sharp)
    print('done', name, flush=True)
