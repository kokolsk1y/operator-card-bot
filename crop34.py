# -*- coding: utf-8 -*-
"""
Обрезает фото товара (на белом/светлом фоне) под соотношение 3:4 (портрет).
Находит товар, центрирует, кадрирует 3:4 вокруг него: лишний фон обрезает,
где не хватает — дорисовывает тем же фоном. Само фото товара не искажает.

  python crop34.py <вход> <выход.png>

В stdout — JSON: {"status":"ok","w":..,"h":..}
"""
import sys, json
import numpy as np
from PIL import Image

TARGET = 3 / 4  # ширина / высота

def main():
    if len(sys.argv) < 3:
        print(json.dumps({"status": "fail", "message": "нужны аргументы: вход выход"})); return
    src_path, out_path = sys.argv[1], sys.argv[2]
    try:
        im = Image.open(src_path).convert("RGB")
    except Exception as e:
        print(json.dumps({"status": "fail", "message": f"не открыть фото: {e}"})); return

    W, H = im.size
    a = np.asarray(im).astype(np.int16)

    # цвет фона = медиана 4 углов
    k = max(4, min(W, H) // 20)
    corners = np.concatenate([
        a[:k, :k].reshape(-1, 3), a[:k, -k:].reshape(-1, 3),
        a[-k:, :k].reshape(-1, 3), a[-k:, -k:].reshape(-1, 3)])
    bg = np.median(corners, axis=0)
    bgcol = tuple(int(x) for x in bg)

    # маска товара = где пиксель заметно отличается от фона
    diff = np.abs(a - bg).max(axis=2)
    mask = diff > 30
    colcount, rowcount = mask.sum(0), mask.sum(1)
    cth, rth = max(3, int(H * 0.01)), max(3, int(W * 0.01))   # шумо-порог
    cols, rows = np.where(colcount > cth)[0], np.where(rowcount > rth)[0]
    if len(cols) == 0 or len(rows) == 0:
        x0, y0, x1, y1 = 0, 0, W, H
    else:
        x0, x1 = int(cols.min()), int(cols.max()) + 1
        y0, y1 = int(rows.min()), int(rows.max()) + 1

    pw, ph = x1 - x0, y1 - y0
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    m = int(max(pw, ph) * 0.10)               # отступ вокруг товара 10%
    pw += 2 * m; ph += 2 * m

    # 3:4 бокс вокруг товара
    if pw / ph > TARGET:
        cw, ch = pw, pw / TARGET
    else:
        cw, ch = ph * TARGET, ph
    cw, ch = int(round(cw)), int(round(ch))
    left, top = int(round(cx - cw / 2)), int(round(cy - ch / 2))

    canvas = Image.new("RGB", (cw, ch), bgcol)
    sx0, sy0 = max(0, left), max(0, top)
    sx1, sy1 = min(W, left + cw), min(H, top + ch)
    if sx1 > sx0 and sy1 > sy0:
        canvas.paste(im.crop((sx0, sy0, sx1, sy1)), (sx0 - left, sy0 - top))
    canvas.save(out_path)
    print(json.dumps({"status": "ok", "w": cw, "h": ch}, ensure_ascii=False))

if __name__ == "__main__":
    main()
