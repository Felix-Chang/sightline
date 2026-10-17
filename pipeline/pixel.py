"""Pixel math: deterministic visual-language metrics computed straight from the pixels.

Every function returns a raw number. Raw numbers only need to be *ordered* correctly,
because combine.py converts them to percentiles across the whole collection.
"""

from __future__ import annotations

import cv2
import numpy as np
from PIL import Image
from skimage.metrics import structural_similarity as ssim

ANALYSIS_SIZE = 512
EPS = 1e-6


def load_rgb(path: str) -> Image.Image:
    """Open any image as RGB, compositing transparency onto white."""
    try:
        import pillow_heif  # noqa: F401  (registers HEIC support)

        pillow_heif.register_heif_opener()
    except ImportError:
        pass
    img = Image.open(path)
    img.seek(0)  # first frame of GIFs
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        bg = Image.new("RGBA", img.size, (255, 255, 255, 255))
        img = Image.alpha_composite(bg, img)
    return img.convert("RGB")


def _resize(img: Image.Image, long_side: int) -> np.ndarray:
    w, h = img.size
    s = long_side / max(w, h)
    if s < 1:
        img = img.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS)
    return np.asarray(img)


# --- Saliency (spectral residual, Hou & Zhang 2007) ---------------------------


def saliency_map(gray: np.ndarray) -> np.ndarray:
    small = cv2.resize(gray, (64, 64), interpolation=cv2.INTER_AREA).astype(np.float32)
    f = np.fft.fft2(small)
    log_amp = np.log(np.abs(f) + EPS)
    phase = np.angle(f)
    residual = log_amp - cv2.blur(log_amp, (3, 3))
    sal = np.abs(np.fft.ifft2(np.exp(residual + 1j * phase))) ** 2
    sal = cv2.GaussianBlur(sal.astype(np.float32), (9, 9), 2.5)
    sal = cv2.resize(sal, (gray.shape[1], gray.shape[0]), interpolation=cv2.INTER_LINEAR)
    sal -= sal.min()
    return sal / (sal.max() + EPS)


# --- Individual metric groups -------------------------------------------------


def _color_metrics(rgb: np.ndarray) -> dict[str, float]:
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV).astype(np.float32)
    hue_deg = hsv[..., 0] * 2.0
    sat = hsv[..., 1] / 255.0
    val = hsv[..., 2] / 255.0
    w = sat * val  # chroma weight: gray, black and white pixels carry no hue
    w_sum = w.sum() + EPS
    chroma_level = float(np.clip(w.mean() / 0.25, 0, 1))  # 0 = grayscale image

    warm_mask = (hue_deg < 70) | (hue_deg >= 330)
    cool_mask = (hue_deg >= 150) & (hue_deg < 290)
    warm = float((w * warm_mask).sum() / w_sum) * chroma_level
    cool = float((w * cool_mask).sum() / w_sum) * chroma_level

    # 36-bin hue histogram (10 degrees each), lightly smoothed around the circle.
    hist, _ = np.histogram(hue_deg, bins=36, range=(0, 360), weights=w)
    hist = hist / (hist.sum() + EPS)
    smooth = hist + 0.5 * (np.roll(hist, 1) + np.roll(hist, -1))
    opposite = np.minimum(smooth, np.roll(smooth, 18))  # bins 180 degrees apart
    complementary = float(opposite.max() / (smooth.max() + EPS)) * chroma_level

    # Hue concentration: resultant length of chroma-weighted hue angles (1 = one hue).
    theta = np.deg2rad(hue_deg)
    resultant = float(np.hypot((w * np.cos(theta)).sum(), (w * np.sin(theta)).sum()) / w_sum)
    monochromatic = chroma_level * resultant + (1 - chroma_level)  # grayscale counts as mono

    # Hasler & Suesstrunk colorfulness.
    r, g, b = (rgb[..., i].astype(np.float32) for i in range(3))
    rg, yb = r - g, 0.5 * (r + g) - b
    colorfulness = float(np.hypot(rg.std(), yb.std()) + 0.3 * np.hypot(rg.mean(), yb.mean()))
    contrast_color = 0.5 * min(colorfulness / 100, 1) + 0.5 * min(float(sat.std()) / 0.35, 1)

    # Palette size: occupied cells of a 4x4x4 RGB cube (each > 0.5% of pixels).
    q = (rgb // 64).reshape(-1, 3)
    codes = q[:, 0] * 16 + q[:, 1] * 4 + q[:, 2]
    counts = np.bincount(codes, minlength=64) / len(codes)
    palette_size = int((counts > 0.005).sum())

    return {
        "color_warm": warm,
        "color_cool": cool,
        "color_complementary": complementary,
        "color_monochromatic": monochromatic,
        "contrast_color": contrast_color,
        "colorfulness": colorfulness,
        "chroma_level": chroma_level,
        "hue_concentration": resultant,
        "palette_size": palette_size,
    }


def _line_metrics(gray: np.ndarray, edges: np.ndarray) -> dict[str, float]:
    h, w = gray.shape
    edge_px = float((edges > 0).sum()) + EPS
    diag = float(np.hypot(h, w))

    # Straight: share of edge pixels explained by long straight Hough segments.
    segs = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=40,
                           minLineLength=int(0.06 * diag), maxLineGap=4)
    if segs is None:
        seg_len = 0.0
    else:
        segs = segs.reshape(-1, 4).astype(np.float32)  # shape varies across OpenCV versions
        seg_len = float(np.hypot(segs[:, 2] - segs[:, 0], segs[:, 3] - segs[:, 1]).sum())
    straight = min(seg_len / edge_px, 1.0)

    # Curved vs jagged: turning angles along edge contours.
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
    step = 6
    smooth_turns = sharp_turns = samples = 0
    for c in contours:
        pts = c[:, 0, :].astype(np.float32)
        if len(pts) < 8 * step:
            continue
        p = pts[::step]
        v = np.diff(p, axis=0)
        ang = np.arctan2(v[:, 1], v[:, 0])
        turn = np.abs((np.diff(ang) + np.pi) % (2 * np.pi) - np.pi)
        turn = np.degrees(turn)
        samples += len(turn)
        smooth_turns += int(((turn > 2) & (turn < 35)).sum())
        sharp_turns += int(((turn >= 55) & (turn < 150)).sum())  # >=150 is the contour folding back
    # Scale by how much line work there is, so one small shape doesn't max out the score.
    presence = min(edge_px / (0.03 * h * w), 1.0)
    curved = smooth_turns / (samples + EPS) * presence
    jagged = sharp_turns / (samples + EPS) * presence

    return {"line_straight": straight, "line_curved": curved, "line_jagged": jagged}


def _shape_metrics(gray: np.ndarray, edges: np.ndarray) -> dict[str, float]:
    h, w = gray.shape
    area_img = float(h * w)
    closed = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=1)
    contours, _ = cv2.findContours(closed, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    totals = {"triangle": 0.0, "rectangle": 0.0, "circle": 0.0}
    for c in contours:
        area = cv2.contourArea(c)
        if area < 0.01 * area_img or area > 0.95 * area_img:
            continue
        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, 0.03 * peri, True)
        circularity = 4 * np.pi * area / (peri * peri + EPS)
        n = len(approx)
        if n == 3:
            totals["triangle"] += area
        elif n == 4 and cv2.isContourConvex(approx):
            totals["rectangle"] += area
        elif n >= 7 and circularity > 0.8:
            totals["circle"] += area
    return {f"shape_{k}": min(v / area_img, 1.0) for k, v in totals.items()}


def _symmetry_metrics(gray: np.ndarray) -> dict[str, float]:
    g = cv2.resize(gray, (256, 256), interpolation=cv2.INTER_AREA)
    lr = float(ssim(g, np.fliplr(g), data_range=255))
    ud = float(ssim(g, np.flipud(g), data_range=255))

    # Radial: compare the centered square crop with rotated copies inside a circle.
    hh, ww = gray.shape
    s = min(hh, ww)
    sq = gray[(hh - s) // 2:(hh - s) // 2 + s, (ww - s) // 2:(ww - s) // 2 + s]
    sq = cv2.resize(sq, (256, 256), interpolation=cv2.INTER_AREA)
    yy, xx = np.mgrid[:256, :256]
    mask = (xx - 127.5) ** 2 + (yy - 127.5) ** 2 <= 127 ** 2
    sims = []
    for angle in (45, 90):
        m = cv2.getRotationMatrix2D((127.5, 127.5), angle, 1.0)
        rot = cv2.warpAffine(sq, m, (256, 256), borderMode=cv2.BORDER_REFLECT)
        _, full = ssim(sq, rot, data_range=255, full=True)
        sims.append(float(full[mask].mean()))
    radial = float(np.mean(sims))
    return {"balance_bilateral": max(lr, 0.8 * ud), "balance_radial": radial,
            "symmetry_lr": lr, "symmetry_ud": ud}


def _orientation_metrics(gray: np.ndarray) -> dict[str, float]:
    g = gray.astype(np.float32) / 255.0
    gx = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
    mag = np.hypot(gx, gy)
    strong = mag > np.percentile(mag, 80)
    # Edge direction is perpendicular to the gradient; fold to [0, 180).
    edge_dir = (np.degrees(np.arctan2(gy, gx)) + 90.0) % 180.0
    diag_mask = ((edge_dir > 25) & (edge_dir < 65)) | ((edge_dir > 115) & (edge_dir < 155))
    diagonal = float((mag * diag_mask * strong).sum() / ((mag * strong).sum() + EPS))

    # Global orientation coherence from the structure tensor (1 = everything points one way).
    jxx, jyy, jxy = (gx * gx).sum(), (gy * gy).sum(), (gx * gy).sum()
    coherence = float(np.sqrt((jxx - jyy) ** 2 + 4 * jxy ** 2) / (jxx + jyy + EPS))
    return {"movement_diagonal": diagonal, "movement_directional": coherence}


def _rhythm_metric(gray: np.ndarray) -> float:
    g = cv2.resize(gray, (256, 256), interpolation=cv2.INTER_AREA).astype(np.float32)
    hp = g - cv2.GaussianBlur(g, (0, 0), 4)  # remove smooth gradients, keep repeated detail
    hp -= hp.mean()
    f = np.fft.fft2(hp)
    ac = np.fft.fftshift(np.real(np.fft.ifft2(f * np.conj(f))))
    ac /= ac[128, 128] + EPS
    yy, xx = np.mgrid[:256, :256]
    # A real repeat has a dip halfway to its peak; a single long edge gives a flat ridge instead.
    halfway = ac[128 + (yy - 128) // 2, 128 + (xx - 128) // 2]
    prominence = ac - halfway
    prominence[(xx - 128) ** 2 + (yy - 128) ** 2 < 8 ** 2] = -np.inf  # ignore the trivial peak
    return float(max(prominence.max(), 0.0))


# --- Entry point --------------------------------------------------------------


def analyze(img: Image.Image) -> dict[str, float]:
    """Return every raw metric for one image. Keys referenced in taxonomy.yaml `pixel:`."""
    rgb = _resize(img, ANALYSIS_SIZE)
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    lum = gray.astype(np.float32) / 255.0

    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    med = float(np.median(blurred))
    edges = cv2.Canny(blurred, int(max(0, 0.66 * med)), int(min(255, 1.33 * med + 30)))
    edge_density = float((edges > 0).mean())

    lap_var = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    texture = float(np.log1p(lap_var))

    hist = np.bincount(gray.ravel(), minlength=256) / gray.size
    entropy = float(-(hist[hist > 0] * np.log2(hist[hist > 0])).sum())

    # Local flatness: pixels whose 9x9 neighborhood barely changes.
    mean = cv2.blur(lum, (9, 9))
    local_std = np.sqrt(np.maximum(cv2.blur(lum * lum, (9, 9)) - mean * mean, 0))
    flat = local_std < 0.012

    sal = saliency_map(gray)
    h, w = gray.shape
    yy, xx = np.mgrid[:h, :w]
    sal_sum = sal.sum() + EPS
    cy, cx = (sal * yy).sum() / sal_sum, (sal * xx).sum() / sal_sum
    centered = 1.0 - float(np.hypot((cx - w / 2) / (w / 2), (cy - h / 2) / (h / 2)) / np.sqrt(2))

    hot = (sal > sal.mean() + 2 * sal.std()).astype(np.uint8)
    n, labels = cv2.connectedComponents(hot)
    if n > 1:
        mass = np.array([sal[labels == i].sum() for i in range(1, n)])
        isolation = float(mass.max() / (mass.sum() + EPS)) * (1 - float(hot.mean()))
    else:
        isolation = 0.0
    negative = float(((sal < 0.15) & flat).mean())

    color = _color_metrics(rgb)
    metrics: dict[str, float] = {
        "mean_luminance": float(lum.mean()),
        "value_high": float(lum.mean()),
        "value_low": 1.0 - float(lum.mean()),
        "contrast_value": float(lum.std()),
        "texture_rough": texture,
        "texture_smooth": -texture,
        "edge_density": edge_density,
        "entropy": entropy,
        "flat_fraction": float(flat.mean()),
        "space_shallow": float(flat.mean()),
        "space_negative": negative,
        "emphasis_centered": centered,
        "emphasis_isolation": isolation,
        "rhythm_regular": _rhythm_metric(gray),
        "unity_chaotic": 0.5 * min(edge_density / 0.2, 1) + 0.3 * entropy / 8
        + 0.2 * min(color["palette_size"] / 24, 1),
        "unity_minimal": 0.5 * (1 - min(edge_density / 0.2, 1)) + 0.3 * negative
        + 0.2 * (1 - min(color["palette_size"] / 24, 1)),
        "unity_harmonious": 0.6 * color["hue_concentration"] * color["chroma_level"]
        + 0.4 * (1 - min(color["palette_size"] / 24, 1)),
    }
    metrics.update(color)
    metrics.update(_line_metrics(gray, edges))
    metrics.update(_shape_metrics(gray, edges))
    sym = _symmetry_metrics(gray)
    structure = min(edge_density / 0.01, 1.0)  # an empty canvas is trivially "symmetric"
    sym["balance_bilateral"] *= structure
    sym["balance_radial"] *= structure
    metrics.update(sym)
    metrics.update(_orientation_metrics(gray))
    return {k: round(float(v), 6) for k, v in metrics.items()}
