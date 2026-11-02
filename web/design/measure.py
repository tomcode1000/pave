"""
Design check: lists the bright marks (text lines, icons) inside a box of a frame, with their tight
boxes and colour, so the page can put its own text exactly where the design has it.
`python design/measure.py <frame> [x0 y0 x1 y1] [--grid]`   (design pixels; --grid also writes
design/_grid.png, the box enlarged 2x with a 10px grid)
"""
import os
import sys
import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
name = sys.argv[1]
nums = [int(a) for a in sys.argv[2:6]] if len(sys.argv) >= 6 else [0, 0, 1280, 720]
x0, y0, x1, y1 = nums
im = cv2.imread(os.path.join(HERE, 'src', name + '.jpg'))
reg = im[y0:y1, x0:x1]
gray = reg.max(axis=2).astype(np.int16)
# a mark is brighter than the local background by a clear step
bg = cv2.medianBlur(reg, 21).max(axis=2).astype(np.int16)
mask = ((gray - bg) > 45).astype(np.uint8) * 255
lines = cv2.dilate(mask, np.ones((3, 9), np.uint8))
n, lab, st, _ = cv2.connectedComponentsWithStats(lines)
out = []
for i in range(1, n):
    x, y, w, h, a = st[i]
    if a < 25:
        continue
    sub = mask[y:y + h, x:x + w]
    ys, xs = np.nonzero(sub)
    if not len(xs):
        continue
    bx0, by0, bx1, by1 = x + xs.min(), y + ys.min(), x + xs.max(), y + ys.max()
    px = reg[by0:by1 + 1, bx0:bx1 + 1][sub[ys.min():ys.max() + 1, xs.min():xs.max() + 1] > 0]
    b, g, r = px.mean(axis=0).astype(int)
    kind = 'gold' if r > 180 and g > 120 and b < 110 else 'green' if g > r + 30 else 'red' if r > g + 60 else 'white' if min(r, g, b) > 170 else 'gray'
    out.append((by0 + y0, bx0 + x0, bx1 + x0, by1 + y0, kind))
out.sort()
for t, l, r, b, k in out:
    print(f'x {l:4}-{r:4}  y {t:3}-{b:3}  h {b - t:2}  {k}')

if '--grid' in sys.argv:
    big = cv2.resize(reg, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
    for gx in range((x0 // 10 + 1) * 10, x1, 10):
        X = (gx - x0) * 2
        cv2.line(big, (X, 0), (X, big.shape[0]), (0, 0, 255) if gx % 100 == 0 else (0, 0, 90), 1)
        if gx % 100 == 0:
            cv2.putText(big, str(gx), (X + 2, 12), cv2.FONT_HERSHEY_SIMPLEX, .4, (0, 255, 0), 1)
    for gy in range((y0 // 10 + 1) * 10, y1, 10):
        Y = (gy - y0) * 2
        cv2.line(big, (0, Y), (big.shape[1], Y), (0, 0, 255) if gy % 100 == 0 else (0, 0, 90), 1)
        if gy % 100 == 0:
            cv2.putText(big, str(gy), (2, Y + 12), cv2.FONT_HERSHEY_SIMPLEX, .4, (0, 255, 0), 1)
    cv2.imwrite(os.path.join(HERE, '_grid.png'), big)
