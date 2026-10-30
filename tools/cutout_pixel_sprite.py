# -*- coding: utf-8 -*-
"""
把使用者指定的像素圖去背成遊戲精靈（v2：修掉「袍子被挖空 → 遊戲裡看起來一片黑」）

v1 的錯：用「連到邊界的白色」當背景直接灌水，結果白色袍子和白色畫板是連通的，
        描邊有細縫 → 灌水漏進袍子裡，整個身體被挖掉 38%，遊戲裡只剩描邊＝看起來像黑色剪影。

v2 的做法：
  1. 先算「背景相似」（薄荷綠邊框 + 近白）
  2. 把「非背景」的核心（描邊、髮色、披風…）**膨脹 2px**，把描邊的細縫補起來
  3. 再從畫布邊界灌水 → 水進不了袍子裡
  4. 遮罩 = 沒被灌到的區域，只保留最大連通塊（順便濾掉殘線與雜點）
"""
from collections import Counter
import numpy as np
from PIL import Image
from scipy import ndimage

SRC = r"C:\Users\pourq\AppData\Roaming\Hermes\composer-images\image_effb5c.png"
OUT = r"D:\hermes_\pig_party\sprites\gudong_pixel.png"

im = Image.open(SRC).convert("RGBA")
a = np.asarray(im).astype(np.int16)
rgb, al = a[..., :3], a[..., 3]
H, W = al.shape

ring = np.concatenate([rgb[0, :, :], rgb[:, 0, :], rgb[:, -1, :]])
cnt = Counter(map(tuple, ring.tolist()))
BG = [np.array(c) for c, _ in cnt.most_common(3)]
print("邊框色", [c.tolist() for c in BG])


def near(col, ref, tol):
    d = np.abs(col[..., None, :] - ref.reshape(1, 1, 3)).max(-1)
    return d[..., 0] <= tol if d.ndim == 3 else d <= tol


bg_like = al < 128
for c in BG:
    bg_like = bg_like | near(rgb, c, 16)
bg_like = bg_like | (rgb.min(-1) > 226)

core = np.logical_not(bg_like)
core_d = ndimage.binary_dilation(core, iterations=2)
open_bg = bg_like & np.logical_not(core_d)

lab, n = ndimage.label(open_bg)
edge = set(lab[0, :].tolist()) | set(lab[-1, :].tolist()) | set(lab[:, 0].tolist()) | set(lab[:, -1].tolist())
edge.discard(0)
outside = np.isin(lab, list(edge))
mask = np.logical_not(outside)

lab2, n2 = ndimage.label(mask)
sizes = ndimage.sum(mask, lab2, range(1, n2 + 1))
keep = int(np.argmax(sizes)) + 1
mask = lab2 == keep
print("連通塊", n2, "最大", int(sizes[keep - 1]))

out = a.copy()
out[..., 3] = np.where(mask, np.maximum(al, 200), 0)
img = Image.fromarray(out.astype(np.uint8), "RGBA")
box = img.getbbox()
print("bbox", box)
img = img.crop(box)
if img.height > 720:
    k = 720 / img.height
    img = img.resize((max(1, round(img.width * k)), 720), Image.NEAREST)
padded = Image.new("RGBA", (img.width + 4, img.height + 2), (0, 0, 0, 0))
padded.paste(img, (2, 0))
padded.save(OUT)
print("存檔", OUT, padded.size)

px = padded.load()
w, h = padded.size
hole = tot = whi = 0
for y in range(int(h * 0.45), int(h * 0.85)):
    for x in range(int(w * 0.30), int(w * 0.70)):
        tot += 1
        if px[x, y][3] < 64:
            hole += 1
        if px[x, y][3] > 128 and min(px[x, y][:3]) > 200:
            whi += 1
print(f"袍子區：透明 {hole*100/tot:.1f}%  近白 {whi*100/tot:.1f}%")

h110 = padded.resize((max(1, round(padded.width * 110 / padded.height)), 110), Image.LANCZOS)
h110.resize((h110.width * 5, h110.height * 5), Image.NEAREST).save(
    r"C:\Users\pourq\AppData\Local\hermes\cache\scratch\pixel_fix110.png")
print("110px", h110.size)
