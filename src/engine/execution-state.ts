/**
 * Execution State Manager
 *
 * Manages the state of SOP execution including context, visited nodes, and conversation history.
 */

import { ExecutionState } from '../types/sop.types'
import { createLogger } from '../utils/logger'

const logger = createLogger('ExecutionState')

export class ExecutionStateManager {
  private state: ExecutionState

  constructor(startNodeId: string, userId: string) {
    this.state = {
      userId: userId,
      currentNodeId: startNodeId,
      visitedNodes: [startNodeId], // Mark start node as visited
      context: {
        userId: userId, // Store userId in context for use in tool params
      },
      timestamp: new Date(),
      conversationHistory: [],
      status: 'in_progress',
    }
  }

  /**
   * Get the current execution state
   */
  getState(): ExecutionState {
    return { ...this.state }
  }

  /**
   * Update the current node
   */
  setCurrentNode(nodeId: string): void {
    this.state.currentNodeId = nodeId
    this.state.visitedNodes.push(nodeId)
  }

  /**
   * Add data to the context
   */
  updateContext(key: string, value: any): void {
    this.state.context[key] = value
    logger.debug({ key, value }, 'Context updated')
  }

  /**
   * Get a value from the context
   */
  getContextValue(key: string): any {
    return this.state.context[key]
  }

  /**
   * Add a message to conversation history
   */
  addMessage(role: 'user' | 'assistant', content: string): void {
    this.state.conversationHistory.push({
      role,
      content,
      timestamp: new Date(),
    })
  }

  /**
   * Get conversation history
   */
  getConversationHistory(): Array<{
    role: 'user' | 'assistant'
    content: string
    timestamp: Date
  }> {
    return [...this.state.conversationHistory]
  }

  /**
   * Mark execution as completed
   */
  complete(): void {
    this.state.status = 'completed'
  }

  /**
   * Mark execution as error
   */
  error(): void {
    this.state.status = 'error'
  }

  /**
   * Check if a node has been visited
   */
  hasVisited(nodeId: string): boolean {
    return this.state.visitedNodes.includes(nodeId)
  }

  /**
   * Get the entire context
   */
  getContext(): Record<string, any> {
    return { ...this.state.context }
  }

  /**
   * Replace placeholders in a string with context values
   * Supports format: {context.key} or {context.nested.key}
   */
  replacePlaceholders(template: string): string {
    return template.replace(/\{context\.([^}]+)\}/g, (match, path) => {
      const keys = path.split('.')
      let value: any = this.state.context

      for (const key of keys) {
        if (value && typeof value === 'object' && key in value) {
          value = value[key]
        } else {
          return match // Return original if path not found
        }
      }

      return String(value)
    })
  }

  /**
   * Evaluate a condition against the current context
   * Simple evaluation supporting comparison operators
   */
  evaluateCondition(condition: string): boolean {
    try {
      // Replace context placeholders with actual values
      const evaluableCondition = condition.replace(
        /context\.([a-zA-Z0-9_.]+)/g,
        (match, path) => {
          const keys = path.split('.')
          let value: any = this.state.context

          for (const key of keys) {
            if (value && typeof value === 'object' && key in value) {
              value = value[key]
            } else {
              return 'undefined'
            }
          }

          // Wrap strings in quotes for evaluation
          if (typeof value === 'string') {
            return `"${value}"`
          }
          return String(value)
        }
      )

      // Use Function constructor for safe evaluation (better than eval)
      // This is still limited and should be enhanced for production
      const result = new Function(`return ${evaluableCondition}`)()
      return Boolean(result)
    } catch (error) {
      logger.error({ condition, error }, 'Error evaluating condition')
      return false
    }
  }
}
