import { GoogleGenerativeAI } from '@google/generative-ai'
import type { Message } from '../../shared/types'
import type { StreamChunk } from './anthropic-client'

export class GoogleClient {
  private client: GoogleGenerativeAI | null = null

  constructor(apiKey: string) {
    if (apiKey) {
      this.client = new GoogleGenerativeAI(apiKey)
    }
  }

  setApiKey(apiKey: string): void {
    this.client = new GoogleGenerativeAI(apiKey)
  }

  async validateApiKey(): Promise<boolean> {
    if (!this.client) return false

    try {
      // Simple test request to validate API key
      const model = this.client.getGenerativeModel({ model: 'gemini-pro' })
      await model.generateContent('Hi')
      return true
    } catch (error) {
      console.error('Google API Key validation failed:', error)
      return false
    }
  }

  async *sendMessage(
    messages: Message[],
    model: string = 'gemini-pro',
    temperature: number = 1.0
  ): AsyncGenerator<StreamChunk> {
    if (!this.client) {
      throw new Error('Google client not initialized. API key missing.')
    }

    try {
      const genModel = this.client.getGenerativeModel({
        model,
        generationConfig: {
          temperature
        }
      })

      // Convert messages to Gemini format (history + current message)
      // Gemini expects conversation history as "parts" array

      // Validate messages array is not empty
      if (messages.length === 0) {
        throw new Error('Messages array cannot be empty')
      }

      // Convert messages to Gemini format with vision support
      const history = messages.slice(0, -1).map((msg) => ({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: msg.attachments?.length
          ? [
              { text: msg.content },
              ...msg.attachments
                .filter((att) => att.type === 'image')
                .map((att) => ({
                  inlineData: { mimeType: att.mimeType, data: att.data }
                }))
            ]
          : [{ text: msg.content }]
      }))

      const lastMsg = messages[messages.length - 1]
      const currentParts = lastMsg.attachments?.length
        ? [
            { text: lastMsg.content },
            ...lastMsg.attachments
              .filter((att) => att.type === 'image')
              .map((att) => ({
                inlineData: { mimeType: att.mimeType, data: att.data }
              }))
          ]
        : lastMsg.content

      // Start chat with history
      const chat = genModel.startChat({
        history
      })

      // Stream the response
      const result = await chat.sendMessageStream(currentParts)

      // Process stream chunks
      for await (const chunk of result.stream) {
        const text = chunk.text()
        if (text) {
          yield {
            content: text,
            done: false
          }
        }
      }

      yield {
        content: '',
        done: true
      }
    } catch (error) {
      console.error('Google API error:', error)
      throw new Error(`Failed to send message: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  async sendMessageNonStreaming(
    messages: Message[],
    model: string = 'gemini-pro',
    temperature: number = 1.0
  ): Promise<string> {
    if (!this.client) {
      throw new Error('Google client not initialized. API key missing.')
    }

    try {
      const genModel = this.client.getGenerativeModel({
        model,
        generationConfig: {
          temperature
        }
      })

      // Convert messages to Gemini format with vision support
      const history = messages.slice(0, -1).map((msg) => ({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: msg.attachments?.length
          ? [
              { text: msg.content },
              ...msg.attachments
                .filter((att) => att.type === 'image')
                .map((att) => ({
                  inlineData: { mimeType: att.mimeType, data: att.data }
                }))
            ]
          : [{ text: msg.content }]
      }))

      const lastMsg = messages[messages.length - 1]
      const currentParts = lastMsg.attachments?.length
        ? [
            { text: lastMsg.content },
            ...lastMsg.attachments
              .filter((att) => att.type === 'image')
              .map((att) => ({
                inlineData: { mimeType: att.mimeType, data: att.data }
              }))
          ]
        : lastMsg.content

      const chat = genModel.startChat({
        history
      })

      const result = await chat.sendMessage(currentParts)
      const response = await result.response
      return response.text()
    } catch (error) {
      console.error('Google API error:', error)
      throw new Error(`Failed to send message: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  // Get available models
  getModels(): string[] {
    return [
      'gemini-pro',
      'gemini-pro-vision' // For image inputs (future feature)
    ]
  }
}
