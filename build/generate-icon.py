#!/usr/bin/env python3
"""
Generate Mingly app icon as 1024x1024 PNG.
Uses only Python stdlib (no Pillow needed).
Creates a modern gradient icon with the 'M' lettermark.
"""

import struct
import zlib
import math
import os

SIZE = 1024

def create_png(width, height, pixels):
    """Create a PNG file from RGBA pixel data."""
    def make_chunk(chunk_type, data):
        chunk = chunk_type + data
        return struct.pack('>I', len(data)) + chunk + struct.pack('>I', zlib.crc32(chunk) & 0xffffffff)

    # IHDR
    ihdr_data = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)  # 8-bit RGBA
    ihdr = make_chunk(b'IHDR', ihdr_data)

    # IDAT - raw image data with filter bytes
    raw_data = b''
    for y in range(height):
        raw_data += b'\x00'  # filter: none
        for x in range(width):
            idx = (y * width + x) * 4
            raw_data += bytes(pixels[idx:idx+4])

    compressed = zlib.compress(raw_data, 9)
    idat = make_chunk(b'IDAT', compressed)

    # IEND
    iend = make_chunk(b'IEND', b'')

    return b'\x89PNG\r\n\x1a\n' + ihdr + idat + iend


def lerp_color(c1, c2, t):
    """Linear interpolation between two RGBA colors."""
    return tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(4))


def distance(x1, y1, x2, y2):
    return math.sqrt((x2-x1)**2 + (y2-y1)**2)


def draw_rounded_rect(pixels, w, h, x1, y1, x2, y2, radius, color):
    """Draw a filled rounded rectangle."""
    for y in range(max(0, y1), min(h, y2)):
        for x in range(max(0, x1), min(w, x2)):
            # Check if inside rounded corners
            inside = True
            for cx, cy in [(x1+radius, y1+radius), (x2-radius, y1+radius),
                           (x1+radius, y2-radius), (x2-radius, y2-radius)]:
                if ((x < x1+radius or x >= x2-radius) and
                    (y < y1+radius or y >= y2-radius)):
                    if distance(x, y, cx, cy) > radius:
                        inside = False
                        break
            if inside:
                idx = (y * w + x) * 4
                pixels[idx:idx+4] = list(color)


def draw_circle(pixels, w, h, cx, cy, radius, color):
    """Draw a filled circle with anti-aliasing."""
    r2 = radius * radius
    for y in range(max(0, int(cy-radius-2)), min(h, int(cy+radius+2))):
        for x in range(max(0, int(cx-radius-2)), min(w, int(cx+radius+2))):
            d2 = (x - cx)**2 + (y - cy)**2
            if d2 <= r2:
                idx = (y * w + x) * 4
                # Simple alpha blend for anti-aliasing at edges
                edge_dist = math.sqrt(d2) - (radius - 1.5)
                if edge_dist > 0:
                    alpha = max(0, min(255, int(255 * (1 - edge_dist / 1.5))))
                    bg = pixels[idx:idx+4]
                    for i in range(3):
                        pixels[idx+i] = int(bg[i] * (1 - alpha/255) + color[i] * (alpha/255))
                    pixels[idx+3] = max(bg[3], alpha)
                else:
                    pixels[idx:idx+4] = list(color)


def draw_thick_line(pixels, w, h, x1, y1, x2, y2, thickness, color):
    """Draw a thick line segment."""
    dx = x2 - x1
    dy = y2 - y1
    length = max(1, math.sqrt(dx*dx + dy*dy))
    steps = int(length * 2)

    half_t = thickness / 2
    for step in range(steps + 1):
        t = step / max(1, steps)
        cx = x1 + dx * t
        cy = y1 + dy * t
        for oy in range(int(-half_t - 1), int(half_t + 2)):
            for ox in range(int(-half_t - 1), int(half_t + 2)):
                px = int(cx + ox)
                py = int(cy + oy)
                if 0 <= px < w and 0 <= py < h:
                    dist = math.sqrt(ox*ox + oy*oy)
                    if dist <= half_t:
                        idx = (py * w + px) * 4
                        pixels[idx:idx+4] = list(color)


def generate_icon():
    w = h = SIZE
    pixels = [0] * (w * h * 4)  # RGBA

    # Colors - modern gradient palette
    # Deep navy → electric blue gradient
    color_top = (15, 23, 62, 255)       # Deep navy
    color_bottom = (37, 99, 235, 255)   # Electric blue
    accent = (99, 179, 237, 255)        # Light blue accent
    white = (255, 255, 255, 255)

    # Background: rounded square with gradient
    corner_radius = int(SIZE * 0.22)  # ~225px iOS-style radius

    for y in range(h):
        t = y / h
        bg_color = lerp_color(color_top, color_bottom, t * t)  # Quadratic gradient

        for x in range(w):
            # Check rounded corners
            inside = True
            corners = [
                (corner_radius, corner_radius),
                (w - corner_radius, corner_radius),
                (corner_radius, h - corner_radius),
                (w - corner_radius, h - corner_radius)
            ]
            for cx, cy in corners:
                in_corner_region = False
                if x < corner_radius and y < corner_radius:
                    in_corner_region = (cx == corner_radius and cy == corner_radius)
                elif x >= w - corner_radius and y < corner_radius:
                    in_corner_region = (cx == w - corner_radius and cy == corner_radius)
                elif x < corner_radius and y >= h - corner_radius:
                    in_corner_region = (cx == corner_radius and cy == h - corner_radius)
                elif x >= w - corner_radius and y >= h - corner_radius:
                    in_corner_region = (cx == w - corner_radius and cy == h - corner_radius)

                if in_corner_region:
                    if distance(x, y, cx, cy) > corner_radius:
                        inside = False
                    break

            if inside:
                idx = (y * w + x) * 4
                pixels[idx:idx+4] = list(bg_color)

    # Draw the "M" lettermark - bold, modern, slightly stylized
    # Using thick lines for a clean geometric M

    margin = int(SIZE * 0.22)
    top = margin + int(SIZE * 0.05)
    bottom = SIZE - margin - int(SIZE * 0.05)
    left = margin + int(SIZE * 0.02)
    right = SIZE - margin - int(SIZE * 0.02)
    mid_x = SIZE // 2
    mid_y = int(top + (bottom - top) * 0.55)  # Middle dip point

    stroke = int(SIZE * 0.075)  # Line thickness

    # Left vertical stroke
    draw_thick_line(pixels, w, h, left, top, left, bottom, stroke, white)

    # Left diagonal to center
    draw_thick_line(pixels, w, h, left, top, mid_x, mid_y, stroke, white)

    # Right diagonal from center
    draw_thick_line(pixels, w, h, mid_x, mid_y, right, top, stroke, white)

    # Right vertical stroke
    draw_thick_line(pixels, w, h, right, top, right, bottom, stroke, white)

    # Small accent dots at the peaks (adds character)
    dot_r = int(SIZE * 0.025)
    draw_circle(pixels, w, h, left, top, dot_r + 4, accent)
    draw_circle(pixels, w, h, right, top, dot_r + 4, accent)
    draw_circle(pixels, w, h, mid_x, mid_y, dot_r + 2, accent)

    # Subtle glow effect - small bright circle at top center
    glow_y = int(SIZE * 0.12)
    glow_r = int(SIZE * 0.06)
    for y in range(max(0, glow_y - glow_r*3), min(h, glow_y + glow_r*3)):
        for x in range(max(0, mid_x - glow_r*3), min(w, mid_x + glow_r*3)):
            d = distance(x, y, mid_x, glow_y)
            if d < glow_r * 2.5:
                alpha = max(0, int(35 * (1 - d / (glow_r * 2.5))))
                idx = (y * w + x) * 4
                if pixels[idx + 3] > 0:  # Only on existing background
                    for i in range(3):
                        pixels[idx+i] = min(255, pixels[idx+i] + alpha)

    return create_png(w, h, pixels)


if __name__ == '__main__':
    print("Generating 1024x1024 icon...")
    png_data = generate_icon()

    output_path = os.path.join(os.path.dirname(__file__), 'icon.png')
    with open(output_path, 'wb') as f:
        f.write(png_data)

    print(f"Icon saved to {output_path} ({len(png_data)} bytes)")
