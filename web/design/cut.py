"""
Cuts the pictures for the site out of the Figma exports in design/src (1280x720 JPGs), and
paints out the text and buttons baked into them so the page can set those live on top.
`python design/cut.py` (from web/) -> assets/*.jpg

Where design/src2x/<n>.png exists (design/upscale.py, or a 2x export from Figma) the pictures
are cut from it at twice the size, for sharp screens; every box below stays in design pixels.

Each design is cleaned once, then cut into pieces: the whole frame below the nav bar (the
section's backdrop on wide screens, where the page places its text on the same spots) and the
single pictures that the narrow-screen layout stacks.

Patches, in design pixels:
  text  - rectangles whose bright pixels (letters) are painted out from their surroundings;
          used over scenery, where the page's own text then sits on the same spot
  whole - rectangles painted out whole from their surroundings (pills, buttons, a panel the page draws)
  flat  - rectangles on a plain card, refilled with the card's own top-to-bottom shade
  disc  - circles painted out (the $WIF coin, which the page floats on its own)

A cutout is cut from the original with its circle as the only opaque part (PNG).
"""
import os
import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'src')
SRC2X = os.path.join(HERE, 'src2x')
OUT = os.path.join(HERE, '..', 'assets')
FRAME = (0, 86, 1280, 720)  # everything below the nav bar


def ring(cx, cy, r):  # a card's number ring (01, 02, 03): the page draws it
    return (cx - r, cy - r, cx + r, cy + r)


DESIGNS = {
    '4': dict(
        text=[((55, 236, 830, 398), 70), ((55, 405, 530, 465), 70)],
        whole=[(58, 170, 336, 222), (58, 490, 506, 558)],
        pieces={'hero': FRAME},
    ),
    '1': dict(
        text=[((440, 152, 845, 206), 40), ((383, 204, 910, 260), 40), ((395, 258, 888, 312), 40)],
        whole=[(543, 104, 737, 152), (44, 606, 1238, 690)],
        flat=[ring(120, 357, 25), (152, 340, 330, 414), ring(539, 357, 25), (570, 340, 722, 414), ring(938, 357, 25), (970, 340, 1160, 432)],
        pieces={'how': FRAME, 'step-1': (50, 318, 415, 600), 'step-2': (470, 318, 810, 600), 'step-3': (868, 318, 1240, 600)},
    ),
    '2': dict(
        text=[((265, 146, 1042, 202), 40), ((332, 200, 948, 254), 40)],
        whole=[(546, 103, 734, 149)],
        flat=[(1016, 292, 1146, 316), (1015, 318, 1110, 353), (972, 386, 1068, 412), (1116, 384, 1228, 413),
              (972, 440, 1058, 462), (1136, 431, 1228, 468), (930, 489, 1032, 512), (928, 514, 1230, 533), (176, 606, 250, 652), (416, 606, 470, 652), (660, 606, 748, 652), (910, 606, 975, 652), (1130, 606, 1226, 652)],
        pieces={'map': FRAME, 'map-art': (0, 246, 905, 580),
                'profile': (905, 258, 1250, 558), 'legend': (38, 578, 1245, 688)},
    ),
    '3': dict(
        text=[((393, 140, 892, 200), 40), ((373, 196, 912, 254), 40), ((298, 254, 984, 290), 40),
              ((146, 306, 250, 356), 70), ((416, 306, 482, 356), 70), ((656, 306, 756, 356), 70), ((991, 304, 1066, 354), 70)],
        whole=[(528, 96, 752, 140), (162, 357, 231, 389), (414, 357, 481, 389), (675, 357, 741, 389), (992, 355, 1065, 387)],
        flat=[(330, 578, 482, 646), (486, 612, 626, 650), (666, 588, 978, 638), (1030, 586, 1210, 646)],
        pieces={'road': FRAME, 'road-levels': (0, 292, 1280, 540), 'defaulted': (48, 548, 1232, 680)},
    ),
    '5': dict(
        text=[((55, 284, 640, 336), 50)],
        whole=[(56, 116, 264, 160), (55, 160, 770, 284), (48, 610, 1238, 690)],
        flat=[ring(98, 476, 22), (128, 458, 296, 532), (90, 538, 200, 566), ring(408, 476, 22), (438, 458, 590, 532),
              ring(697, 476, 22), (725, 458, 878, 532),
              (980, 364, 1120, 392), (950, 442, 1066, 488), (1094, 442, 1216, 488), (950, 532, 1066, 578), (1094, 532, 1216, 578)],
        disc=[(1022.5, 137.5, 56)],
        cutouts={'coin': (1022.5, 137.5, 54)},
        pieces={'vouch': FRAME, 'hands': (760, 86, 1280, 352), 'vstep-1': (55, 355, 316, 590), 'vstep-2': (368, 355, 606, 590),
                'vstep-3': (656, 355, 893, 590), 'rewards': (927, 351, 1233, 590)},
    ),
}


def clean(im, s, text=(), whole=(), flat=(), disc=()):
    sc = lambda box: tuple(int(round(v * s)) for v in box)
    mask = np.zeros(im.shape[:2], np.uint8)
    for box, t in text:
        x0, y0, x1, y1 = sc(box)
        region = im[y0:y1, x0:x1]
        mask[y0:y1, x0:x1] = np.where(region.max(axis=2) > t, 255, 0).astype(np.uint8)
    mask = cv2.dilate(mask, np.ones((4 * s + 1, 4 * s + 1), np.uint8))
    for box in whole:
        x0, y0, x1, y1 = sc(box)
        mask[y0:y1, x0:x1] = 255
    for cx, cy, r in disc:
        cv2.circle(mask, (round(cx * s), round(cy * s)), round(r * s), 255, -1)
    if mask.any():
        im = cv2.inpaint(im, mask, 6 * s, cv2.INPAINT_TELEA)
    for box in flat:
        x0, y0, x1, y1 = sc(box)
        # the card's shade just above and just below the patch (the median, so a bright icon at
        # the edge doesn't streak), blended down the rows
        top = np.median(im[y0 - 4:y0 - 1, x0:x1].reshape(-1, 3).astype(np.float32), axis=0)
        bot = np.median(im[y1 + 1:y1 + 4, x0:x1].reshape(-1, 3).astype(np.float32), axis=0)
        k = np.linspace(0, 1, y1 - y0, dtype=np.float32)[:, None, None]
        im[y0:y1, x0:x1] = (top * (1 - k) + bot * k).clip(0, 255).astype(np.uint8)
    return im


def cutout(im, s, name, circle):
    cx, cy, r = (v * s for v in circle)
    x0, y0, x1, y1 = (round(v) for v in (cx - r, cy - r, cx + r, cy + r))
    rgba = cv2.cvtColor(im[y0:y1, x0:x1], cv2.COLOR_BGR2BGRA)
    a = np.zeros(rgba.shape[:2], np.float32)
    cv2.circle(a, (round(cx - x0), round(cy - y0)), round(r - s), 1, -1)
    rgba[:, :, 3] = (cv2.GaussianBlur(a, (0, 0), s) * 255).astype(np.uint8)  # a soft edge
    cv2.imwrite(os.path.join(OUT, name + '.png'), rgba)


def save(im, s, name, box):
    x0, y0, x1, y1 = (int(round(v * s)) for v in box)
    cv2.imwrite(os.path.join(OUT, name + '.jpg'), im[y0:y1, x0:x1], [cv2.IMWRITE_JPEG_QUALITY, 88 if s > 1 else 92])


os.makedirs(OUT, exist_ok=True)
n = 0
for src, d in DESIGNS.items():
    big = os.path.join(SRC2X, src + '.png')
    s = 2 if os.path.exists(big) else 1
    raw = cv2.imread(big if s > 1 else os.path.join(SRC, src + '.jpg'))
    for name, circle in d.get('cutouts', {}).items():
        cutout(raw, s, name, circle); n += 1
    im = clean(raw.copy(), s, d.get('text', ()), d.get('whole', ()), d.get('flat', ()), d.get('disc', ()))
    for name, box in d['pieces'].items():
        save(im, s, name, box); n += 1
print(f'cut {n} pictures into assets/')
