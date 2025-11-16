/**
 * SOP Agent - LLM-Driven Architecture
 *
 * The LLM receives the complete SOP definition and execution state on every interaction.
 * It decides navigation, tool execution, and responses based on the SOP workflow.
 */

import { ChatOpenAI } from '@langchain/openai'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SOP } from '../types/sop.types'
import { ExecutionStateManager } from './execution-state'

export class SOPAgent {
  private sop: SOP
  private stateManager: ExecutionStateManager
  private llm: ChatOpenAI
  private mcpClient: Client | null = null
  private availableTools: Map<string, any> = new Map()

  constructor(sop: SOP, llm: ChatOpenAI) {
    this.sop = sop
    this.stateManager = new ExecutionStateManager(sop.startNode)
    this.llm = llm
  }

  /**
   * Initialize MCP client connection
   */
  async initializeMCP(
    serverCommand: string,
    serverArgs: string[]
  ): Promise<void> {
    this.mcpClient = new Client(
      {
        name: 'sop-agent-client',
        version: '1.0.0',
      },
      {
        capabilities: {},
      }
    )

    const transport = new StdioClientTransport({
      command: serverCommand,
      args: serverArgs,
    })

    await this.mcpClient.connect(transport)

    // List available tools
    const toolsResponse: any = await this.mcpClient.listTools()

    if (toolsResponse.tools) {
      for (const tool of toolsResponse.tools) {
        this.availableTools.set(tool.name, tool)
      }
      console.log(`Loaded ${this.availableTools.size} tools from MCP server`)
    }
  }

  /**
   * Build the system prompt that includes SOP definition and current state
   */
  private buildSystemPrompt(): string {
    const state = this.stateManager.getState()
    const currentNode = this.sop.nodes[state.currentNodeId]

    return `You are a customer support AI agent following a Standard Operating Procedure (SOP).

# YOUR ROLE
You must follow the SOP workflow precisely while maintaining natural conversation with the customer.

# SOP DEFINITION
${JSON.stringify(this.sop, null, 2)}

# CURRENT EXECUTION STATE
- Current Node: ${state.currentNodeId}
- Node Type: ${currentNode?.type}
- Node Description: ${currentNode?.description}
- Visited Nodes: ${JSON.stringify(state.visitedNodes)}
- Status: ${state.status}

# CURRENT CONTEXT
${JSON.stringify(state.context, null, 2)}

# CONVERSATION HISTORY
${state.conversationHistory.map((msg) => `${msg.role}: ${msg.content}`).join('\n')}

# INSTRUCTIONS

1. **Language Support**: 
   - ALWAYS respond in the same language the user is using
   - Detect the user's language from their messages
   - Maintain consistency - if the user speaks Spanish, respond in Spanish; if German, respond in German, etc.
   - Support ALL languages naturally

2. **CRITICAL: Follow the SOP Flow**: You are currently at node "${state.currentNodeId}". Based on the node type and the SOP definition, determine what action to take next and guide the user accordingly.

3. **Node Types**:
   - **action**: Perform the described action. If a tool is specified, use it. If a messageTemplate exists, respond to the user with that message (with placeholders replaced from context).
   - **decision**: Evaluate the condition based on the current context. Decide which path to take.
   - **end**: The workflow is complete. Provide the final message.

4. **Tool Execution**: When a node specifies a tool, you MUST call that tool with the appropriate parameters. Extract parameters from the context using the toolParams mapping.

5. **Context Management**: 
   - Extract information from user messages (e.g., order IDs, decisions)
   - Store tool results in context for use in subsequent nodes
   - Use context values to replace placeholders in message templates

6. **Navigation**:
   - After completing an action node, determine the next node from nextNodes
   - For decision nodes, evaluate the condition and choose the appropriate next node
   - Update your understanding of the current node as you progress
   - **CRITICAL**: If the current node's next node is an "end" type node, you MUST automatically transition to it WITHOUT asking if the user needs more help

7. **End Node Handling**:
   - When the next node after the current action is an "end" type node, DO NOT ask "Is there anything else I can help you with?"
   - Instead, provide your response and then immediately transition to the end node
   - Remove any "can I help you with anything else?" type questions from your response when approaching an end node
   - The conversation should conclude naturally without prompting for additional interactions

8. **Natural Conversation**: While following the SOP strictly, maintain a natural, helpful tone in the user's language.

9. **Response Format**: Your response should:
   - Address the user naturally in their language
   - Call tools when required by the current node
   - Extract any needed information from the user's message into context
   - If moving to an end node next, conclude the conversation gracefully without offering additional help
   - **CRITICAL**: NEVER include thinking, internal processing, workflow navigation, or meta-commentary in your response
   - Respond ONLY with the customer-facing message - no explanations of what you're doing internally
   - Do NOT use phrases like "Thinking:", "<thinking>", "Based on the SOP workflow", "Moving to node", etc.
   - Your response should be clean, natural conversation ONLY

# AVAILABLE TOOLS
${Array.from(this.availableTools.values())
  .map((tool) => `- ${tool.name}: ${tool.description}`)
  .join('\n')}

Now, process the user's message according to the SOP workflow.`
  }

  /**
   * Execute a tool via MCP
   */
  private async executeTool(
    toolName: string,
    parameters: Record<string, any>
  ): Promise<any> {
    if (!this.mcpClient) {
      throw new Error('MCP client not initialized')
    }

    console.log(`Executing tool: ${toolName} with params:`, parameters)

    const response: any = await this.mcpClient.callTool({
      name: toolName,
      arguments: parameters,
    })

    // Parse the response
    if (response.content && response.content.length > 0) {
      const content = response.content[0]
      if (content.type === 'text') {
        return JSON.parse(content.text)
      }
    }

    return response
  }

  /**
   * Convert MCP tools to LangChain tool format
   */
  private getLangChainTools() {
    const tools = []

    for (const [name, tool] of this.availableTools) {
      tools.push({
        type: 'function' as const,
        function: {
          name: name,
          description: tool.description || `Execute ${name} tool`,
          parameters: tool.inputSchema || {
            type: 'object',
            properties: {},
          },
        },
      })
    }

    return tools
  }

  /**
   * Clean LLM response by removing thinking traces and metadata
   */
  private cleanResponse(rawResponse: string): string {
    let cleaned = rawResponse.trim()

    // Remove thinking sections in various formats
    // Remove content between **Thinking:** and next paragraph or line break
    cleaned = cleaned.replace(
      /\*\*Thinking:?\*\*[\s\S]*?(?=\n\n|\n[A-Z]|$)/gi,
      ''
    )

    // Remove content in <thinking> tags
    cleaned = cleaned.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')

    // Remove content between [Thinking] markers
    cleaned = cleaned.replace(/\[Thinking\][\s\S]*?(?=\n\n|\n[A-Z]|$)/gi, '')

    // Remove workflow/node navigation metadata
    cleaned = cleaned.replace(
      /\*\*Workflow[^*]*\*\*:?[\s\S]*?(?=\n\n|\n[A-Z]|$)/gi,
      ''
    )
    cleaned = cleaned.replace(/---\s*\n\n\*\*Workflow[\s\S]*$/gi, '')

    // Remove internal processing sections
    cleaned = cleaned.replace(
      /---\s*\n*\*\*Internal Processing:?\*\*[\s\S]*$/gi,
      ''
    )
    cleaned = cleaned.replace(
      /---\s*\n*\*\*Internal State Update:?\*\*[\s\S]*$/gi,
      ''
    )
    cleaned = cleaned.replace(/\*\*Internal Note:?\*\*[\s\S]*$/gi, '')
    cleaned = cleaned.replace(/---\s*\n*Internal Processing:[\s\S]*$/gi, '')
    cleaned = cleaned.replace(/\*\*My internal processing:?\*\*[\s\S]*$/gi, '')

    // Remove function call markup that might leak through
    cleaned = cleaned.replace(
      /<function_calls>[\s\S]*?<\/function_calls>/gi,
      ''
    )
    cleaned = cleaned.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')

    // Remove "Based on the SOP workflow..." meta-commentary
    cleaned = cleaned.replace(/Based on the SOP workflow[^.]*\./gi, '')

    // Remove "Let me execute..." and "I'll wait for..." meta-commentary
    cleaned = cleaned.replace(/Let me execute the \w+ tool:?\s*\n*/gi, '')
    cleaned = cleaned.replace(/I'll wait for the \w+ result[^.]*\.\s*\n*/gi, '')

    // Remove navigation instructions like "I've reached the..." or "Moving to node..."
    cleaned = cleaned.replace(
      /I've reached the `[^`]+` node[\s\S]*?(?=\n\n|[A-Z])/gi,
      ''
    )
    cleaned = cleaned.replace(
      /Moving to node `[^`]+`[\s\S]*?(?=\n\n|[A-Z])/gi,
      ''
    )

    // Remove "The conversation has concluded..." type endings
    cleaned = cleaned.replace(/---\s*\n*The conversation has[\s\S]*$/gi, '')

    // Clean up excessive whitespace
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim()

    return cleaned
  }

  /**
   * Advance through simple action nodes that don't require tools or user input
   * This ensures we're at the right node before building the prompt
   */
  private advanceThroughSimpleNodes(): void {
    const state = this.stateManager.getState()
    let currentNode = this.sop.nodes[state.currentNodeId]
    let maxIterations = 5 // Safety limit
    let iterations = 0

    while (currentNode && iterations < maxIterations) {
      iterations++

      // Stop if we've reached an end node
      if (currentNode.type === 'end') {
        break
      }

      // Stop if there are no next nodes
      if (!currentNode.nextNodes || currentNode.nextNodes.length === 0) {
        break
      }

      // Only advance if this is a simple action node (no tool, no decision)
      if (currentNode.type === 'action' && !currentNode.tool) {
        // Advance to the next node
        this.stateManager.setCurrentNode(currentNode.nextNodes[0])
        currentNode = this.sop.nodes[currentNode.nextNodes[0]]
      } else {
        // Stop - we've reached a node that requires action or decision
        break
      }
    }
  }

  /**
   * Check if current node transitions to an end node
   */
  private isTransitioningToEnd(): boolean {
    const state = this.stateManager.getState()
    const currentNode = this.sop.nodes[state.currentNodeId]

    if (
      !currentNode ||
      !currentNode.nextNodes ||
      currentNode.nextNodes.length === 0
    ) {
      return false
    }

    // Check if any of the next nodes is an end node
    for (const nextNodeId of currentNode.nextNodes) {
      const nextNode = this.sop.nodes[nextNodeId]
      if (nextNode && nextNode.type === 'end') {
        return true
      }
    }

    return false
  }

  /**
   * Remove help offers from response when transitioning to end
   */
  private removeHelpOffers(response: string): string {
    if (!this.isTransitioningToEnd()) {
      return response
    }

    let cleaned = response

    // Remove common help offer patterns in multiple languages
    // English variations
    cleaned = cleaned.replace(
      /[.!]\s*Is there anything else I can help you with\??\s*/gi,
      '.'
    )
    cleaned = cleaned.replace(
      /[.!]\s*Can I help you with anything else\??\s*/gi,
      '.'
    )
    cleaned = cleaned.replace(
      /[.!]\s*How else can I assist you( today)?\??\s*/gi,
      '.'
    )
    cleaned = cleaned.replace(
      /[.!]\s*Is there anything else you need\??\s*/gi,
      '.'
    )
    cleaned = cleaned.replace(
      /[.!]\s*Do you need any further assistance\??\s*/gi,
      '.'
    )
    cleaned = cleaned.replace(
      /[.!]\s*Let me know if you need anything else[.!]?\s*/gi,
      '.'
    )
    cleaned = cleaned.replace(
      /[.!]\s*Feel free to reach out if you need further help[.!]?\s*/gi,
      '.'
    )

    // Spanish variations
    cleaned = cleaned.replace(
      /[.!]\s*¿Hay algo más en lo que pueda ayudarte\??\s*/gi,
      '.'
    )
    cleaned = cleaned.replace(
      /[.!]\s*¿Puedo ayudarte con algo más\??\s*/gi,
      '.'
    )
    cleaned = cleaned.replace(/[.!]\s*¿Necesitas algo más\??\s*/gi, '.')

    // German variations
    cleaned = cleaned.replace(
      /[.!]\s*Kann ich Ihnen sonst noch helfen\??\s*/gi,
      '.'
    )
    cleaned = cleaned.replace(
      /[.!]\s*Gibt es noch etwas, bei dem ich helfen kann\??\s*/gi,
      '.'
    )

    // Clean up any resulting double periods or excessive whitespace
    cleaned = cleaned.replace(/\.{2,}/g, '.')
    cleaned = cleaned.replace(/\s{2,}/g, ' ')
    cleaned = cleaned.trim()

    return cleaned
  }

  /**
   * Process a user message using LLM-driven navigation
   */
  async processMessage(userMessage: string): Promise<string> {
    // Add user message to history
    this.stateManager.addMessage('user', userMessage)

    // Advance through simple action nodes (greeting, etc.) before building prompt
    this.advanceThroughSimpleNodes()

    // Build system prompt with SOP and state
    const systemPrompt = this.buildSystemPrompt()

    // Prepare messages for LLM
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ]

    // Get LangChain-formatted tools
    const tools = this.getLangChainTools()

    // Bind tools to the model (required for Anthropic/Claude)
    // Use bindTools method for proper tool binding
    const modelWithTools =
      tools.length > 0 ? this.llm.bindTools(tools) : this.llm

    // Call LLM with tool calling enabled
    let response
    try {
      response = await modelWithTools.invoke(messages)
    } catch (error) {
      console.error('Error calling LLM:', error)
      return 'I apologize, but I encountered an error processing your request. Please try again.'
    }

    let assistantMessage = ''

    // Process tool calls if any
    if (response.additional_kwargs?.tool_calls) {
      for (const toolCall of response.additional_kwargs.tool_calls) {
        const toolName = toolCall.function.name
        const toolArgs = JSON.parse(toolCall.function.arguments)

        try {
          // Execute the tool via MCP
          const toolResult = await this.executeTool(toolName, toolArgs)
          console.log(`Tool ${toolName} result:`, toolResult)

          // Update context with tool result based on tool name
          if (toolName === 'getOrderStatus') {
            this.stateManager.updateContext('orderStatus', toolResult)
            // Also extract specific fields for easier access
            if (toolResult.orderId) {
              this.stateManager.updateContext('orderId', toolResult.orderId)
            }
          } else if (toolName === 'cancelOrder') {
            this.stateManager.updateContext('cancelResult', toolResult)
          } else if (toolName === 'refundOrder') {
            this.stateManager.updateContext('refundResult', toolResult)
          }

          // Now call LLM again with tool result to get natural response
          const followUpMessages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
            {
              role: 'assistant',
              content: '',
              tool_calls: [toolCall],
            },
            {
              role: 'tool',
              content: JSON.stringify(toolResult),
              tool_call_id: toolCall.id,
            },
          ]

          const followUpResponse = await modelWithTools.invoke(followUpMessages)
          const rawMessage = followUpResponse.content.toString().trim()
          assistantMessage = this.cleanResponse(rawMessage)

          // If the response is empty after tool execution, reconnect the flow
          if (!assistantMessage) {
            console.log(
              'Empty response after tool execution, reconnecting flow...'
            )
            assistantMessage = await this.reconnectFlow(
              userMessage,
              toolName,
              toolResult
            )
          }
        } catch (error) {
          console.error(`Error executing tool ${toolName}:`, error)
          assistantMessage = `I encountered an error while processing your request: ${error instanceof Error ? error.message : String(error)}`
          this.stateManager.error()
        }
      }
    } else {
      // No tool calls, just get the text response
      const rawMessage = response.content.toString().trim()
      assistantMessage = this.cleanResponse(rawMessage)
    }

    // Ensure we always have a response
    if (!assistantMessage) {
      console.log('Empty response received, generating fallback response...')
      assistantMessage = await this.generateFallbackResponse(userMessage)
    }

    // Extract information from the conversation for context
    this.extractContextFromMessages(userMessage, assistantMessage)

    // Update current node based on LLM's progress BEFORE cleaning help offers
    // The LLM should indicate in its response what it's doing
    this.updateCurrentNode(assistantMessage)

    // Remove help offers if we're transitioning to an end node (after updateCurrentNode)
    assistantMessage = this.removeHelpOffers(assistantMessage)

    // Add assistant message to history
    this.stateManager.addMessage('assistant', assistantMessage)

    // Check if we've reached an end node (after updateCurrentNode)
    const currentNode =
      this.sop.nodes[this.stateManager.getState().currentNodeId]
    if (currentNode?.type === 'end') {
      this.stateManager.complete()
    }

    return assistantMessage
  }

  /**
   * Reconnect the flow when empty response is received after tool execution
   */
  private async reconnectFlow(
    userMessage: string,
    toolName: string,
    toolResult: any
  ): Promise<string> {
    const state = this.stateManager.getState()
    const currentNode = this.sop.nodes[state.currentNodeId]

    // Simple prompt that just asks for a response based on the tool result
    // Do NOT use buildSystemPrompt() here to avoid triggering new tool calls
    const simplePrompt = `You are a helpful customer support agent. You just successfully executed the ${toolName} tool with this result:

${JSON.stringify(toolResult, null, 2)}

The customer said: "${userMessage}"

Please provide a natural, conversational response to the customer in their language, informing them about what was done. Be concise and helpful.

DO NOT call any tools - just provide a text response to the customer.`

    try {
      // Use the base LLM WITHOUT tool binding to prevent new tool calls
      const response = await this.llm.invoke([
        { role: 'system', content: simplePrompt },
        {
          role: 'user',
          content: 'Please respond to the customer based on the tool result.',
        },
      ])

      const rawMessage = response.content.toString().trim()
      const message = this.cleanResponse(rawMessage)
      if (message) {
        return message
      }
    } catch (error) {
      console.error('Error in reconnectFlow:', error)
    }

    // Final fallback based on tool type
    return this.getToolBasedFallback(toolName, toolResult)
  }

  /**
   * Generate a fallback response when no response is received
   */
  private async generateFallbackResponse(userMessage: string): Promise<string> {
    const state = this.stateManager.getState()
    const currentNode = this.sop.nodes[state.currentNodeId]

    const fallbackPrompt = `The user said: "${userMessage}"

You are at node: ${state.currentNodeId} (${currentNode?.description})
Context: ${JSON.stringify(state.context)}

Please provide a helpful response to the user in their language based on the current SOP state. 
You MUST respond - do not leave this empty.`

    try {
      const response = await this.llm.invoke([
        { role: 'system', content: this.buildSystemPrompt() },
        { role: 'user', content: fallbackPrompt },
      ])

      const rawMessage = response.content.toString().trim()
      const message = this.cleanResponse(rawMessage)
      if (message) {
        return message
      }
    } catch (error) {
      console.error('Error in generateFallbackResponse:', error)
    }

    // Absolute final fallback
    return 'I understand. How else can I assist you today?'
  }

  /**
   * Get a tool-based fallback message
   */
  private getToolBasedFallback(toolName: string, toolResult: any): string {
    if (toolName === 'getOrderStatus' && toolResult?.orderId) {
      return `I've checked your order #${toolResult.orderId}. The status is ${toolResult.status}. How can I help you further?`
    } else if (toolName === 'cancelOrder' && toolResult?.orderId) {
      return `I've cancelled order #${toolResult.orderId}. Is there anything else I can help you with?`
    } else if (toolName === 'refundOrder' && toolResult?.orderId) {
      return `I've processed the refund for order #${toolResult.orderId}. Is there anything else you need?`
    }
    return "I've completed the requested action. How else can I assist you?"
  }

  /**
   * Extract context information from messages
   */
  private extractContextFromMessages(
    userMessage: string,
    assistantMessage: string
  ): void {
    // Extract order ID if mentioned
    if (!this.stateManager.getContextValue('orderId')) {
      const orderIdMatch = userMessage.match(/\b(\d{5})\b/)
      if (orderIdMatch) {
        this.stateManager.updateContext('orderId', orderIdMatch[1])
      }
    }

    // Detect customer's intent for cancellation
    const lowerUser = userMessage.toLowerCase()
    const state = this.stateManager.getState()

    // Check if we're in a decision-making context (agent has offered cancellation)
    if (
      state.currentNodeId === 'customer_decision' ||
      this.stateManager.getContextValue('offeringCancellation')
    ) {
      // Negative responses indicating desire to keep the order - CHECK FIRST
      const wantsToKeep =
        lowerUser.startsWith('no') ||
        lowerUser.includes(' no,') ||
        lowerUser.includes(' no ') ||
        lowerUser.includes('keep') ||
        lowerUser.includes('wait') ||
        lowerUser.includes("don't cancel") ||
        lowerUser.includes("i'll wait") ||
        lowerUser.includes('i will wait') ||
        lowerUser.includes('no thanks') ||
        lowerUser.includes('not cancel')

      // Positive responses indicating desire to cancel
      const wantsToCancel =
        ((lowerUser.startsWith('yes') ||
          lowerUser.includes(' yes,') ||
          lowerUser.includes(' yes ')) &&
          !lowerUser.includes('no')) ||
        ((lowerUser.includes('cancel') || lowerUser.includes('refund')) &&
          !lowerUser.includes('no') &&
          !lowerUser.includes("don't"))

      if (wantsToKeep) {
        this.stateManager.updateContext('customerWantsCancellation', false)
        console.log(
          'Customer declined cancellation - customerWantsCancellation set to false'
        )
      } else if (wantsToCancel) {
        this.stateManager.updateContext('customerWantsCancellation', true)
        console.log(
          'Customer accepted cancellation - customerWantsCancellation set to true'
        )
      }
    }

    // Track if we're offering cancellation
    const lowerAssistant = assistantMessage.toLowerCase()
    if (
      (lowerAssistant.includes('cancel') ||
        lowerAssistant.includes('refund')) &&
      lowerAssistant.includes('?')
    ) {
      this.stateManager.updateContext('offeringCancellation', true)
    }
  }

  /**
   * Update current node based on conversation progress
   * This is a simplified heuristic - in a full implementation,
   * the LLM would explicitly state the next node
   */
  private updateCurrentNode(assistantMessage: string): void {
    const state = this.stateManager.getState()
    let currentNode = this.sop.nodes[state.currentNodeId]

    if (!currentNode || currentNode.type === 'end') {
      return
    }

    // Nodes that have completed their action and should auto-advance
    // These are nodes where the agent has already provided the response or executed the tool
    const completedActionNodes = [
      'provide_status',
      'confirm_cancellation',
      'continue_with_order',
    ]

    // Keep advancing through decision nodes and completed action nodes
    // until we reach a node that requires user input or an end node
    let maxIterations = 10 // Safety limit to prevent infinite loops
    let iterations = 0

    while (
      currentNode &&
      currentNode.type !== 'end' &&
      iterations < maxIterations
    ) {
      iterations++

      if (!currentNode.nextNodes || currentNode.nextNodes.length === 0) {
        break
      }

      // Determine if we should advance from this node
      let shouldAdvance = false

      if (currentNode.type === 'decision') {
        // Always advance through decision nodes - they just evaluate conditions
        shouldAdvance = true
      } else if (currentNode.type === 'action') {
        // For action nodes with tools, check if the tool has been executed
        if (currentNode.tool) {
          shouldAdvance = this.hasToolBeenExecuted(
            currentNode.tool,
            state.context
          )
        } else {
          // For action nodes without tools (just messages), check if they're marked as completed
          shouldAdvance = completedActionNodes.includes(currentNode.id)
        }
      }

      if (!shouldAdvance) {
        break
      }

      let nextNodeId = currentNode.nextNodes[0]

      // Handle decision nodes - evaluate condition and choose path
      if (currentNode.type === 'decision' && currentNode.condition) {
        const conditionMet = this.stateManager.evaluateCondition(
          currentNode.condition
        )
        nextNodeId = conditionMet
          ? currentNode.nextNodes[0]
          : currentNode.nextNodes[1]
      }

      // Update to next node
      this.stateManager.setCurrentNode(nextNodeId)
      currentNode = this.sop.nodes[nextNodeId]

      // If we reached an end node, mark it as current and exit loop
      if (currentNode && currentNode.type === 'end') {
        break
      }
    }
  }

  /**
   * Check if a tool has been executed based on context
   */
  private hasToolBeenExecuted(
    toolName: string,
    context: Record<string, any>
  ): boolean {
    if (toolName === 'getOrderStatus') {
      return !!context.orderStatus
    } else if (toolName === 'cancelOrder') {
      return !!context.cancelResult
    } else if (toolName === 'refundOrder') {
      return !!context.refundResult
    }
    return false
  }

  /**
   * Get the current execution state
   */
  getExecutionState() {
    return this.stateManager.getState()
  }

  /**
   * Check if conversation is complete
   */
  isComplete(): boolean {
    const state = this.stateManager.getState()
    return state.status === 'completed'
  }

  /**
   * Reset the agent to start over
   */
  reset(): void {
    this.stateManager = new ExecutionStateManager(this.sop.startNode)
  }

  /**
   * Close MCP connection
   */
  async close(): Promise<void> {
    if (this.mcpClient) {
      await this.mcpClient.close()
    }
  }
}
