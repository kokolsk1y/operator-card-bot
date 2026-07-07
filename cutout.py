# -*- coding: utf-8 -*-
"""
Вырезка фона с фото товара для бота операторов.

  python cutout.py <вход> <выход.png> [модель]

Модель по умолчанию: birefnet-general (лучшее качество, ~1 ГБ, уже в ~/.u2net/).
Делает: удаление фона -> лёгкое сглаживание края -> tight-crop по товару.
В stdout печатает ОДНУ строку JSON с метриками качества и статусом:
  status = ok | warn | fail
"""
import sys, io, json
import numpy as np
from PIL import Image, ImageFilter

def main():
    if len(sys.argv) < 3:
        print(json.dumps({"status": "fail", "message": "нужны аргументы: вход выход"}))
        return
    src_path, out_path = sys.argv[1], sys.argv[2]
    model = sys.argv[3] if len(sys.argv) > 3 else "birefnet-general"

    try:
        from rembg import remove, new_session
        src = Image.open(src_path).convert("RGB")
        buf = io.BytesIO(); src.save(buf, "PNG")
        sess = new_session(model)
        out = remove(buf.getvalue(), session=sess)
        img = Image.open(io.BytesIO(out)).convert("RGBA")
    except Exception as e:
        print(json.dumps({"status": "fail", "message": f"ошибка вырезки: {e}"}))
        return

    a = np.asarray(img)
    alpha = a[:, :, 3].astype(np.int32)
    H, W = alpha.shape
    tot = H * W
    fg = int((alpha > 200).sum())
    semi = int(((alpha > 20) & (alpha < 200)).sum())
    fg_pct = fg / tot * 100
    semi_pct = semi / tot * 100

    # яркость товара + ДОЛЯ светлых пикселей — для авто-свечения (много светлого = белый товар -> меньше свечения)
    fgmask = alpha > 128
    if fgmask.any():
        px = a[:, :, :3][fgmask].astype(np.float32).mean(axis=1)   # яркость каждого пикселя товара
        lightness = float(px.mean()); bright_pct = float((px > 170).mean() * 100)
    else:
        lightness, bright_pct = 128.0, 30.0

    # фрагментированность силуэта (грубо) — сколько отдельных кусков переднего плана
    n_fg = 1
    try:
        from scipy import ndimage
        _, n_fg = ndimage.label(alpha > 128)
    except Exception:
        pass

    # --- вердикт качества ---
    status, message = "ok", "товар вырезан"
    if fg_pct < 4:
        status, message = "fail", "не нашёл товар на фото — пришли фото, где товар крупно и по центру"
    elif fg_pct > 96:
        status, message = "fail", "фон не отделился — нужен товар на простом светлом фоне"
    elif semi_pct > 6 or n_fg > 250:
        status, message = "warn", "край получился неровный — проверь превью, при необходимости переснимай"

    # --- лёгкое сглаживание края альфы (убирает «лесенку») ---
    alpha_img = img.split()[3].filter(ImageFilter.GaussianBlur(0.6))
    img.putalpha(alpha_img)

    # --- tight-crop по непрозрачной части + небольшой отступ ---
    bbox = img.split()[3].point(lambda v: 255 if v > 16 else 0).getbbox()
    if bbox:
        x0, y0, x1, y1 = bbox
        padx = int((x1 - x0) * 0.03) + 4
        pady = int((y1 - y0) * 0.03) + 4
        x0 = max(0, x0 - padx); y0 = max(0, y0 - pady)
        x1 = min(W, x1 + padx); y1 = min(H, y1 + pady)
        img = img.crop((x0, y0, x1, y1))

    img.save(out_path)
    print(json.dumps({
        "status": status, "message": message,
        "fg_pct": round(fg_pct, 1), "semi_pct": round(semi_pct, 2),
        "n_fg": int(n_fg), "lightness": round(lightness, 1), "bright_pct": round(bright_pct, 1),
        "width": img.width, "height": img.height,
    }, ensure_ascii=False))

if __name__ == "__main__":
    main()
