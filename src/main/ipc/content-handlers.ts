/**
 * IPC Handlers — Templates, Comparison, Export, Image, File Operations
 */

import { ipcMain, dialog } from 'electron'
import * as fs from 'fs/promises'
import { IPC_CHANNELS } from '../../shared/types'
import type { MessageAttachment } from '../../shared/types'
import { ConversationModel } from '../database/models/conversation'
import { MessageModel } from '../database/models/message'
import { validateFilePath } from '../security/input-validator'
import { wrapHandler, requireFeature } from './ipc-utils'

export async function registerContentHandlers(): Promise<void> {

  // ========================================
  // Prompt Templates
  // ========================================

  const { PromptTemplateModel } = await import('../database/models/prompt-template')
  const { seedBuiltinTemplates } = await import('../prompts/builtin-templates')

  // Seed built-in templates on first run
  seedBuiltinTemplates(
    (data) => PromptTemplateModel.create(data),
    PromptTemplateModel.countBuiltins()
  )

  wrapHandler(IPC_CHANNELS.TEMPLATE_CREATE, (data: any) => {
    requireFeature('templates_custom')
    const template = PromptTemplateModel.create(data)
    return { success: true, template }
  })

  wrapHandler(IPC_CHANNELS.TEMPLATE_LIST, (category?: string) => {
    const templates = PromptTemplateModel.findAll(category as any)
    return { success: true, templates }
  })

  wrapHandler(IPC_CHANNELS.TEMPLATE_GET, (id: string) => {
    const template = PromptTemplateModel.findById(id)
    return { success: !!template, template }
  })

  wrapHandler(IPC_CHANNELS.TEMPLATE_UPDATE, (id: string, data: any) => {
    const template = PromptTemplateModel.update(id, data)
    return { success: !!template, template }
  })

  wrapHandler(IPC_CHANNELS.TEMPLATE_DELETE, (id: string) => {
    const success = PromptTemplateModel.delete(id)
    return { success }
  })

  wrapHandler(IPC_CHANNELS.TEMPLATE_TOGGLE_FAVORITE, (id: string) => {
    const template = PromptTemplateModel.toggleFavorite(id)
    return { success: !!template, template }
  })

  wrapHandler(IPC_CHANNELS.TEMPLATE_EXPORT, () => {
    const templates = PromptTemplateModel.findAll()
    return { success: true, data: JSON.stringify(templates, null, 2) }
  })

  wrapHandler(IPC_CHANNELS.TEMPLATE_IMPORT, (jsonString: string) => {
    const items = JSON.parse(jsonString)
    let imported = 0
    for (const item of items) {
      PromptTemplateModel.create({
        name: item.name,
        description: item.description,
        systemPrompt: item.systemPrompt,
        category: item.category || 'custom',
        variables: item.variables,
        isFavorite: false,
        isBuiltin: false
      })
      imported++
    }
    return { success: true, imported }
  })

  // ========================================
  // Model Comparison
  // ========================================

  const { getComparisonService } = await import('../services/comparison-service')
  const comparisonService = getComparisonService()

  wrapHandler(IPC_CHANNELS.COMPARISON_START, async (prompt: string, models: any[]) => {
    requireFeature('comparison')
    const result = await comparisonService.runComparison(prompt, models)
    return { success: true, session: result.session, results: result.results, errors: result.errors }
  })

  wrapHandler(IPC_CHANNELS.COMPARISON_GET_HISTORY, (limit?: number) => {
    const history = comparisonService.getHistory(limit)
    return { success: true, history }
  })

  wrapHandler(IPC_CHANNELS.COMPARISON_MARK_WINNER, (sessionId: string, resultId: string) => {
    const success = comparisonService.markWinner(sessionId, resultId)
    return { success }
  })

  // ========================================
  // Conversation Export
  // ========================================

  wrapHandler(IPC_CHANNELS.EXPORT_CONVERSATION, async (conversationId: string, format: string) => {
    requireFeature('export')
    const { getExportService } = await import('../services/export-service')
    const exportService = getExportService()

    const conversation = ConversationModel.findById(conversationId)
    if (!conversation) throw new Error('Conversation not found')

    const messages = MessageModel.findByConversation(conversationId)
    const exportFormat = format as 'markdown' | 'json' | 'html'

    const extensions: Record<string, string> = { markdown: 'md', json: 'json', html: 'html' }
    const ext = extensions[exportFormat] || 'txt'

    const result = await dialog.showSaveDialog({
      defaultPath: `${conversation.title.replace(/[^a-zA-Z0-9-_ ]/g, '')}.${ext}`,
      filters: [
        { name: `${exportFormat.toUpperCase()} Files`, extensions: [ext] }
      ]
    })

    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true }
    }

    const content = exportService.export({
      title: conversation.title,
      provider: conversation.provider,
      model: conversation.model,
      messages,
      format: exportFormat,
      includeMetadata: true,
      includeImages: exportFormat !== 'markdown'
    })

    await fs.writeFile(result.filePath, content, 'utf-8')
    return { success: true, filePath: result.filePath }
  })

  // ========================================
  // Image / Vision
  // ========================================

  wrapHandler(IPC_CHANNELS.IMAGE_SELECT, async () => {
    requireFeature('multimodal')
    const { processImageFile, MAX_IMAGES_PER_MESSAGE } = await import('../utils/image-processor')

    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }],
      title: 'Select Images'
    })

    if (result.canceled || result.filePaths.length === 0) {
      return { success: true, attachments: [] }
    }

    const paths = result.filePaths.slice(0, MAX_IMAGES_PER_MESSAGE)
    const attachments: MessageAttachment[] = []

    for (const filePath of paths) {
      const att = await processImageFile(filePath)
      attachments.push(att)
    }

    return { success: true, attachments }
  })

  // ========================================
  // File Operations
  // ========================================

  ipcMain.handle(IPC_CHANNELS.SELECT_FILE, async () => {
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: 'Select Directory'
      })
      return { filePaths: result.filePaths, canceled: result.canceled }
    } catch (error) {
      return { filePaths: [], canceled: true, error: (error as Error).message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.READ_FILE, async (_, filePath: string) => {
    try {
      const pathValidation = validateFilePath(filePath)
      if (!pathValidation.valid) {
        return { success: false, error: pathValidation.error }
      }
      const content = await fs.readFile(filePath, 'utf-8')
      return { success: true, content }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })
}
