#!/usr/bin/env python3
"""
Generate Windows .ico from icon.png using only stdlib.
ICO format contains multiple PNG sizes embedded.
"""

import struct
import subprocess
import os
import tempfile

BUILD_DIR = os.path.dirname(__file__)
SIZES = [16, 24, 32, 48, 64, 128, 256]

def create_ico(png_path, ico_path, sizes):
    """Create an ICO file by embedding multiple PNG sizes."""
    # Generate resized PNGs using sips
    png_data_list = []
    for size in sizes:
        with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tmp:
            tmp_path = tmp.name

        subprocess.run(
            ['sips', '-z', str(size), str(size), png_path, '--out', tmp_path],
            capture_output=True
        )

        with open(tmp_path, 'rb') as f:
            png_data_list.append(f.read())
        os.unlink(tmp_path)

    # ICO header
    num_images = len(sizes)
    header = struct.pack('<HHH', 0, 1, num_images)  # Reserved, Type(1=ICO), Count

    # Calculate offsets
    dir_entry_size = 16
    data_offset = 6 + (dir_entry_size * num_images)

    directory = b''
    image_data = b''

    for i, (size, png_bytes) in enumerate(zip(sizes, png_data_list)):
        w = 0 if size >= 256 else size  # 0 means 256 in ICO format
        h = 0 if size >= 256 else size

        entry = struct.pack(
            '<BBBBHHII',
            w,              # Width
            h,              # Height
            0,              # Color palette (0 for PNG)
            0,              # Reserved
            1,              # Color planes
            32,             # Bits per pixel
            len(png_bytes), # Size of image data
            data_offset + len(image_data)  # Offset to image data
        )
        directory += entry
        image_data += png_bytes

    with open(ico_path, 'wb') as f:
        f.write(header + directory + image_data)

    print(f"ICO saved to {ico_path} ({os.path.getsize(ico_path)} bytes, {num_images} sizes)")

if __name__ == '__main__':
    png_path = os.path.join(BUILD_DIR, 'icon.png')
    ico_path = os.path.join(BUILD_DIR, 'icon.ico')
    create_ico(png_path, ico_path, SIZES)
