/**
 * SOP Navigator
 *
 * Handles navigation through SOP nodes based on the decision tree structure.
 */

import { SOP, SOPNode } from '../types/sop.types'
import { ExecutionStateManager } from './execution-state'

export class SOPNavigator {
  private sop: SOP
  private stateManager: ExecutionStateManager
  private userId: string

  constructor(sop: SOP, userId: string) {
    this.sop = sop
    this.userId = userId
    this.stateManager = new ExecutionStateManager(sop.startNode, userId)
  }

  /**
   * Get the current node
   */
  getCurrentNode(): SOPNode | null {
    const currentNodeId = this.stateManager.getState().currentNodeId
    return this.sop.nodes[currentNodeId] || null
  }

  /**
   * Get a node by ID
   */
  getNode(nodeId: string): SOPNode | null {
    return this.sop.nodes[nodeId] || null
  }

  /**
   * Move to the next node based on the current node type and conditions
   */
  async moveToNextNode(): Promise<SOPNode | null> {
    const currentNode = this.getCurrentNode()
    if (
      !currentNode ||
      !currentNode.nextNodes ||
      currentNode.nextNodes.length === 0
    ) {
      return null
    }

    if (currentNode.type === 'decision' && currentNode.condition) {
      // Evaluate the condition to determine which path to take
      const conditionMet = this.stateManager.evaluateCondition(
        currentNode.condition
      )

      // For decision nodes, nextNodes[0] is the "true" path, nextNodes[1] is the "false" path
      const nextNodeId = conditionMet
        ? currentNode.nextNodes[0]
        : currentNode.nextNodes[1]

      if (nextNodeId) {
        this.stateManager.setCurrentNode(nextNodeId)
        return this.getNode(nextNodeId)
      }
    } else {
      // For action nodes, just move to the first (and typically only) next node
      const nextNodeId = currentNode.nextNodes[0]
      if (nextNodeId) {
        this.stateManager.setCurrentNode(nextNodeId)
        return this.getNode(nextNodeId)
      }
    }

    return null
  }

  /**
   * Get the execution state manager
   */
  getStateManager(): ExecutionStateManager {
    return this.stateManager
  }

  /**
   * Check if the SOP execution is complete
   */
  isComplete(): boolean {
    const currentNode = this.getCurrentNode()
    return (
      currentNode?.type === 'end' ||
      this.stateManager.getState().status === 'completed'
    )
  }

  /**
   * Get tool parameters with placeholders replaced
   */
  getToolParameters(node: SOPNode): Record<string, any> {
    if (!node.toolParams) {
      return {}
    }

    const params: Record<string, any> = {}
    for (const [key, value] of Object.entries(node.toolParams)) {
      if (typeof value === 'string') {
        params[key] = this.stateManager.replacePlaceholders(value)
      } else {
        params[key] = value
      }
    }

    return params
  }

  /**
   * Get message template with placeholders replaced
   */
  getFormattedMessage(node: SOPNode): string | null {
    if (!node.messageTemplate) {
      return null
    }

    return this.stateManager.replacePlaceholders(node.messageTemplate)
  }

  /**
   * Reset the navigator to start over
   */
  reset(): void {
    this.stateManager = new ExecutionStateManager(
      this.sop.startNode,
      this.userId
    )
  }

  /**
   * Get SOP metadata
   */
  getSOPInfo(): { name: string; description: string; version: string } {
    return {
      name: this.sop.name,
      description: this.sop.description,
      version: this.sop.version,
    }
  }
}
