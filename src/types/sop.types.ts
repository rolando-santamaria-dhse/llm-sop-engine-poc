/**
 * SOP (Standard Operating Procedure) Type Definitions
 *
 * These types define the structure for representing SOPs as unidirectional decision trees.
 */

export type NodeType = 'action' | 'decision' | 'end'

export interface SOPNode {
  id: string
  type: NodeType
  description: string

  /**
   * Tool to invoke if this is an action node
   */
  tool?: string

  /**
   * Parameters to pass to the tool (can include placeholders from context)
   */
  toolParams?: Record<string, any>

  /**
   * Possible next nodes based on the outcome
   * For action nodes: typically one next node
   * For decision nodes: multiple next nodes based on conditions
   */
  nextNodes?: string[]

  /**
   * Condition to evaluate for decision nodes
   * Can reference context variables (e.g., "context.minutesLate > 20")
   */
  condition?: string

  /**
   * Message template to present to the user (optional)
   * Can include placeholders like {orderId}, {status}, etc.
   */
  messageTemplate?: string
}

export interface SOP {
  name: string
  description: string
  version: string
  startNode: string
  nodes: Record<string, SOPNode>
}

export interface ExecutionState {
  /**
   * Current node in the SOP
   */
  currentNodeId: string

  /**
   * List of visited nodes (for tracking progress)
   */
  visitedNodes: string[]

  /**
   * Context data collected during execution
   * This includes tool results, user inputs, and intermediate calculations
   */
  context: Record<string, any>

  /**
   * Timestamp when execution started
   */
  timestamp: Date

  /**
   * Conversation history
   */
  conversationHistory: Array<{
    role: 'user' | 'assistant'
    content: string
    timestamp: Date
  }>

  /**
   * Status of the execution
   */
  status: 'in_progress' | 'completed' | 'error'
}

export interface SOPExecutionResult {
  success: boolean
  finalState: ExecutionState
  error?: string
}
