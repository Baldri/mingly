import { nativeImage } from 'electron'
import fs from 'fs'
import path from 'path'
import { generateId } from './id-generator'
import type { ImageAttachment } from '../../shared/types'

export const MAX_DIMENSION = 1024
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024 // 10 MB
export const MAX_IMAGES_PER_MESSAGE = 4

const SUPPORTED_MIME_TYPES: Record<string, ImageAttachment['mimeType']> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp'
}

export function getImageMimeType(filename: string): ImageAttachment['mimeType'] | null {
  const ext = filename.toLowerCase().split('.').pop() || ''
  return SUPPORTED_MIME_TYPES[ext] || null
}

export function validateImageFile(filePath: string): { valid: boolean; error?: string } {
  const mimeType = getImageMimeType(filePath)
  if (!mimeType) {
    return { valid: false, error: `Unsupported image format: ${path.extname(filePath)}` }
  }

  const stats = fs.statSync(filePath)
  if (stats.size > MAX_FILE_SIZE_BYTES) {
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(1)
    return { valid: false, error: `Image too large: ${sizeMB} MB (max ${MAX_FILE_SIZE_BYTES / (1024 * 1024)} MB)` }
  }

  return { valid: true }
}

export function validateAttachmentCount(count: number): { valid: boolean; error?: string } {
  if (count > MAX_IMAGES_PER_MESSAGE) {
    return { valid: false, error: `Too many images: ${count} (max ${MAX_IMAGES_PER_MESSAGE})` }
  }
  return { valid: true }
}

export function processImageFile(filePath: string): ImageAttachment {
  const mimeType = getImageMimeType(filePath)
  if (!mimeType) {
    throw new Error(`Unsupported image format: ${path.extname(filePath)}`)
  }

  const originalBuffer = fs.readFileSync(filePath)
  const originalSize = originalBuffer.length

  // Use Electron's nativeImage for resize
  let image = nativeImage.createFromBuffer(originalBuffer)
  const size = image.getSize()

  // Resize if either dimension exceeds max
  if (size.width > MAX_DIMENSION || size.height > MAX_DIMENSION) {
    const scale = MAX_DIMENSION / Math.max(size.width, size.height)
    const newWidth = Math.round(size.width * scale)
    const newHeight = Math.round(size.height * scale)
    image = image.resize({ width: newWidth, height: newHeight, quality: 'better' })
  }

  const finalSize = image.getSize()

  // Encode to the target format
  let data: string
  if (mimeType === 'image/png') {
    data = image.toPNG().toString('base64')
  } else {
    // JPEG for everything else (better compression)
    data = image.toJPEG(85).toString('base64')
  }

  return {
    id: generateId(),
    type: 'image',
    mimeType,
    data,
    filename: path.basename(filePath),
    width: finalSize.width,
    height: finalSize.height,
    originalSize
  }
}

export function processImageBuffer(
  buffer: Buffer,
  mimeType: ImageAttachment['mimeType'],
  filename?: string
): ImageAttachment {
  let image = nativeImage.createFromBuffer(buffer)

  if (image.isEmpty()) {
    throw new Error('Invalid image data')
  }

  const size = image.getSize()

  if (size.width > MAX_DIMENSION || size.height > MAX_DIMENSION) {
    const scale = MAX_DIMENSION / Math.max(size.width, size.height)
    const newWidth = Math.round(size.width * scale)
    const newHeight = Math.round(size.height * scale)
    image = image.resize({ width: newWidth, height: newHeight, quality: 'better' })
  }

  const finalSize = image.getSize()

  let data: string
  if (mimeType === 'image/png') {
    data = image.toPNG().toString('base64')
  } else {
    data = image.toJPEG(85).toString('base64')
  }

  return {
    id: generateId(),
    type: 'image',
    mimeType,
    data,
    filename,
    width: finalSize.width,
    height: finalSize.height,
    originalSize: buffer.length
  }
}
