/**
 * SOP Agent - LLM-Driven Architecture
 *
 * The LLM receives the complete SOP definition and execution state on every interaction.
 * It decides navigation, tool execution, and responses based on the SOP workflow.
 */

import { ChatOpenAI } from '@langchain/openai'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SOP, SOPNode } from '../types/sop.types'
import { ExecutionStateManager } from './execution-state'
import { createLogger } from '../utils/logger'

const logger = createLogger('SOPAgent')

export class SOPAgent {
  private sop: SOP
  private stateManager: ExecutionStateManager
  private llm: ChatOpenAI
  private mcpClient: Client | null = null
  private availableTools: Map<string, any> = new Map()
  private userId: string

  constructor(sop: SOP, llm: ChatOpenAI, userId: string) {
    this.sop = sop
    this.userId = userId
    this.stateManager = new ExecutionStateManager(sop.startNode, userId)
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
      logger.debug(
        { toolCount: this.availableTools.size },
        'Loaded tools from MCP server'
      )
    }
  }

  /**
   * Get current node and all reachable next nodes
   * This provides the minimal context needed for LLM decision-making
   */
  private getRelevantNodes(): {
    current: SOPNode
    next: SOPNode[]
    reachableNodes: Record<string, SOPNode>
  } {
    const state = this.stateManager.getState()
    const currentNode = this.sop.nodes[state.currentNodeId]

    if (!currentNode) {
      throw new Error(`Current node ${state.currentNodeId} not found`)
    }

    const nextNodes: SOPNode[] = []
    const reachableNodes: Record<string, SOPNode> = {
      [currentNode.id]: currentNode,
    }

    // Get immediate next nodes
    if (currentNode.nextNodes) {
      for (const nextNodeId of currentNode.nextNodes) {
        const nextNode = this.sop.nodes[nextNodeId]
        if (nextNode) {
          nextNodes.push(nextNode)
          reachableNodes[nextNodeId] = nextNode

          // For decision nodes, also include their next nodes
          // This gives the LLM visibility into both decision paths
          if (nextNode.type === 'decision' && nextNode.nextNodes) {
            for (const decisionNextId of nextNode.nextNodes) {
              const decisionNextNode = this.sop.nodes[decisionNextId]
              if (decisionNextNode) {
                reachableNodes[decisionNextId] = decisionNextNode
              }
            }
          }
        }
      }
    }

    return { current: currentNode, next: nextNodes, reachableNodes }
  }

  /**
   * Extract context keys referenced in a node
   */
  private extractContextKeys(node: SOPNode, keys: Set<string>): void {
    // Check messageTemplate
    if (node.messageTemplate) {
      const matches = node.messageTemplate.matchAll(/\{context\.([^}]+)\}/g)
      for (const match of matches) {
        const path = match[1].split('.')[0] // Get top-level key
        keys.add(path)
      }
    }

    // Check toolParams
    if (node.toolParams) {
      for (const value of Object.values(node.toolParams)) {
        if (typeof value === 'string' && value.startsWith('{context.')) {
          const key = value.slice(9, -1).split('.')[0]
          keys.add(key)
        }
      }
    }

    // Check condition
    if (node.condition) {
      const matches = node.condition.matchAll(/context\.([a-zA-Z0-9_]+)/g)
      for (const match of matches) {
        keys.add(match[1])
      }
    }
  }

  /**
   * Get only context values referenced by current and next nodes
   */
  private getRelevantContext(): Record<string, any> {
    const { current, next, reachableNodes } = this.getRelevantNodes()
    const allContext = this.stateManager.getContext()
    const relevantKeys = new Set<string>()

    // Extract context keys from all reachable nodes
    for (const node of Object.values(reachableNodes)) {
      this.extractContextKeys(node, relevantKeys)
    }

    // Always include userId
    relevantKeys.add('userId')

    // Build relevant context object
    const relevantContext: Record<string, any> = {}
    for (const key of relevantKeys) {
      if (key in allContext) {
        relevantContext[key] = allContext[key]
      }
    }

    return relevantContext
  }

  /**
   * Build the system prompt that includes only relevant nodes and current state
   * OPTIMIZED: Sends only current + next nodes instead of entire SOP (80-85% token reduction)
   */
  private buildSystemPrompt(): string {
    const state = this.stateManager.getState()
    const { current, next, reachableNodes } = this.getRelevantNodes()
    const relevantContext = this.getRelevantContext()

    // Build next node information
    let nextNodeInfo = 'None (end of workflow)'
    if (next.length > 0) {
      const nextNodeDetails = next.map(
        (node) => `${node.id} (${node.type}: ${node.description})`
      )
      nextNodeInfo = nextNodeDetails.join(', ')
    }

    // Build message template instruction if current node has one
    let messageTemplateInstruction = ''
    if (current.messageTemplate) {
      const filledTemplate = this.stateManager.replacePlaceholders(
        current.messageTemplate
      )
      messageTemplateInstruction = `

# CRITICAL: REQUIRED MESSAGE TEMPLATE FOR CURRENT NODE
The current node (${current.id}) has a MANDATORY message template that you MUST use as the foundation of your response:

TEMPLATE: "${current.messageTemplate}"

FILLED TEMPLATE (with context values): "${filledTemplate}"

YOU MUST base your response on this filled template. You may:
- Translate it to the user's language if needed
- Add natural language connectors
- Adjust the wording slightly for flow

But you MUST NOT:
- Ignore this template
- Create a completely different message
- Skip the key information in the template (e.g., if it asks about cancellation, you MUST ask about cancellation)
`
    }

    return `You are a customer support AI agent following a Standard Operating Procedure (SOP).

# YOUR ROLE
You must follow the SOP workflow precisely while maintaining natural conversation with the customer.

# SOP CONTEXT
SOP Name: ${this.sop.name}
SOP Description: ${this.sop.description}

# CURRENT NODE
${JSON.stringify(current, null, 2)}

# NEXT POSSIBLE NODES
${JSON.stringify(next, null, 2)}

# REACHABLE NODES (for decision context)
${JSON.stringify(reachableNodes, null, 2)}

# CURRENT EXECUTION STATE
- Current Node: ${state.currentNodeId}
- Node Type: ${current.type}
- Node Description: ${current.description}
- Next Node(s): ${nextNodeInfo}
- Visited Nodes: ${JSON.stringify(state.visitedNodes)}
- Status: ${state.status}

# CURRENT CONTEXT
${JSON.stringify(relevantContext, null, 2)}

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
   - **action**: Perform the described action. If a tool is specified, use it. **CRITICAL**: If a messageTemplate exists, you MUST use that exact template as the basis for your response (replacing placeholders with context values). You may add minor natural language flow, but the core message MUST come from the template.
   - **decision**: Evaluate the condition based on the current context. The decision has already been made for you based on the condition - simply proceed to communicate the appropriate next step.
   - **end**: The workflow is complete. Provide the final message from the template.

4. **Tool Execution**: When a node specifies a tool, you MUST call that tool with the appropriate parameters. Extract parameters from the context using the toolParams mapping.

5. **Context Management**: 
   - Extract information from user messages (e.g., order IDs, customer decisions)
   - Store tool results in context for use in subsequent nodes
   - Use context values to replace placeholders in message templates
   - **CRITICAL for Decision Nodes**: When you need to evaluate a decision condition (like "customerWantsCancellation"), you MUST first analyze the user's intent from their message and update the context accordingly BEFORE the decision node is evaluated
   - Example: If the user responds "yes" or "cancel it" to a cancellation offer, you should understand their intent to cancel and ensure the context reflects this (e.g., customerWantsCancellation=true)
   - Example: If the user responds "no" or "I'll wait" to a cancellation offer, you should understand their intent to keep the order and ensure the context reflects this (e.g., customerWantsCancellation=false)
   - Your natural language understanding should determine intent - do not rely on simple keyword matching

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

9. **Message Templates**: **CRITICAL INSTRUCTION**
   - When the current node has a messageTemplate, you MUST base your response on that template
   - Replace all {context.xxx} placeholders with actual values from the context
   - You may enhance the template with natural language and the user's language, but the core information from the template MUST be present
   - Do NOT ignore the template and create a completely different message
   - Example: If template says "order is delayed by X minutes", your response MUST mention this delay, not say "good news, it's on the way"

10. **Response Format**: Your response should:
   - Address the user naturally in their language
   - Call tools when required by the current node
   - Extract any needed information from the user's message into context
   - **Use message templates when provided** - this is mandatory
   - If moving to an end node next, conclude the conversation gracefully without offering additional help
   - **CRITICAL**: NEVER include thinking, internal processing, workflow navigation, or meta-commentary in your response
   - Respond ONLY with the customer-facing message - no explanations of what you're doing internally
   - Do NOT use phrases like "Thinking:", "<thinking>", "Based on the SOP workflow", "Moving to node", etc.
   - Your response should be clean, natural conversation ONLY

# AVAILABLE TOOLS
${Array.from(this.availableTools.values())
  .map((tool) => `- ${tool.name}: ${tool.description}`)
  .join('\n')}
${messageTemplateInstruction}

Now, process the user's message according to the SOP workflow.`
  }

  /**
   * Execute a tool via MCP
   * Always includes userId in the tool parameters
   */
  private async executeTool(
    toolName: string,
    parameters: Record<string, any>
  ): Promise<any> {
    if (!this.mcpClient) {
      throw new Error('MCP client not initialized')
    }

    // Always include userId in tool parameters
    const toolParameters = {
      ...parameters,
      userId: this.userId,
    }

    logger.debug({ toolName, params: toolParameters }, 'Executing tool')

    const response: any = await this.mcpClient.callTool({
      name: toolName,
      arguments: toolParameters,
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
   * Also includes built-in tools like updateContext
   */
  private getLangChainTools() {
    const tools = []

    // Add built-in updateContext tool
    tools.push({
      type: 'function' as const,
      function: {
        name: 'updateContext',
        description:
          'Update context values based on user intent or extracted information. Use this to set context values like customerWantsCancellation, or any other context data needed for decision nodes.',
        parameters: {
          type: 'object',
          properties: {
            key: {
              type: 'string',
              description:
                'The context key to update (e.g., "customerWantsCancellation")',
            },
            value: {
              description:
                'The value to set (can be boolean, string, number, or object)',
            },
          },
          required: ['key', 'value'],
        },
      },
    })

    // Add MCP tools
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
    let maxIterations = 10 // Safety limit
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
      // OR if it's an action node with a tool that has already been executed
      if (currentNode.type === 'action') {
        if (!currentNode.tool) {
          // Simple action node without tool - advance
          this.stateManager.setCurrentNode(currentNode.nextNodes[0])
          currentNode = this.sop.nodes[currentNode.nextNodes[0]]
        } else {
          // Action node with tool - stop here, tool will be executed next
          break
        }
      } else {
        // Decision node or other type - stop
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
   * Execute tool at current node if required
   */
  private async executeNodeTool(): Promise<void> {
    const state = this.stateManager.getState()
    const currentNode = this.sop.nodes[state.currentNodeId]

    if (
      currentNode?.type === 'action' &&
      currentNode.tool &&
      !this.hasToolBeenExecuted(currentNode.tool, state.context)
    ) {
      // Extract parameters from tool params, replacing placeholders
      const params: Record<string, any> = {}
      let hasInvalidParams = false

      if (currentNode.toolParams) {
        for (const [key, value] of Object.entries(currentNode.toolParams)) {
          if (typeof value === 'string' && value.startsWith('{context.')) {
            const contextKey = value.slice(9, -1) // Remove {context. and }
            const contextValue = this.stateManager.getContextValue(contextKey)

            // Check if this is a required parameter and if it's missing
            if (contextValue === null || contextValue === undefined) {
              logger.debug(
                { key, contextKey },
                'Required parameter missing from context'
              )
              hasInvalidParams = true
              break
            }

            params[key] = contextValue
          } else {
            params[key] = value
          }
        }
      }

      // Only execute the tool if all required parameters are present
      if (hasInvalidParams) {
        logger.debug(
          { tool: currentNode.tool },
          'Skipping tool execution - required parameters missing'
        )
        return
      }

      // Execute the tool
      try {
        const toolResult = await this.executeTool(currentNode.tool, params)
        logger.debug(
          { tool: currentNode.tool, result: toolResult },
          'Tool execution result'
        )

        // Store tool result in context using generic pattern
        if (currentNode.tool === 'getUserDetails') {
          this.stateManager.updateContext('userDetails', toolResult)
        } else if (currentNode.tool === 'getOrderStatus') {
          this.stateManager.updateContext('orderStatus', toolResult)
          if (toolResult.orderId) {
            this.stateManager.updateContext('orderId', toolResult.orderId)
          }
        } else if (currentNode.tool === 'cancelOrder') {
          this.stateManager.updateContext('cancelResult', toolResult)
        } else if (currentNode.tool === 'refundOrder') {
          this.stateManager.updateContext('refundResult', toolResult)
        }

        // Only advance if the tool execution was successful (no error in result)
        if (!toolResult.error) {
          // After executing tool, advance through any subsequent decision or action nodes
          this.advanceAfterToolExecution()
        } else {
          logger.debug(
            { tool: currentNode.tool, error: toolResult.error },
            'Tool returned an error - staying at current node'
          )
        }
      } catch (error) {
        logger.error({ tool: currentNode.tool, error }, 'Error executing tool')
        this.stateManager.error()
        throw error
      }
    }
  }

  /**
   * Advance through decision and action nodes after tool execution
   */
  private advanceAfterToolExecution(): void {
    const state = this.stateManager.getState()
    let currentNode = this.sop.nodes[state.currentNodeId]
    let maxIterations = 10
    let iterations = 0

    while (currentNode && iterations < maxIterations) {
      iterations++

      if (!currentNode.nextNodes || currentNode.nextNodes.length === 0) {
        break
      }

      // Stop at end nodes
      if (currentNode.type === 'end') {
        break
      }

      // For action nodes with tools that have been executed:
      // - If the node has a messageTemplate, STOP here so the LLM can render it
      // - If the node has no messageTemplate, advance to next node
      if (
        currentNode.type === 'action' &&
        currentNode.tool &&
        this.hasToolBeenExecuted(currentNode.tool, state.context)
      ) {
        // If this node has a messageTemplate, stop here so it can be shown to the user
        if (currentNode.messageTemplate) {
          break
        }
        // Otherwise, advance to next node
        this.stateManager.setCurrentNode(currentNode.nextNodes[0])
        currentNode = this.sop.nodes[currentNode.nextNodes[0]]
        continue
      }

      // For decision nodes, check if the data needed is valid before evaluating
      if (currentNode.type === 'decision' && currentNode.condition) {
        // Check if any context data referenced in the condition has errors
        if (this.hasErrorsInConditionContext(currentNode.condition)) {
          logger.debug(
            { nodeId: currentNode.id },
            'Decision node cannot be evaluated - context data has errors'
          )
          break
        }

        // Check if all required values for the decision are set
        if (!this.canEvaluateDecision(currentNode.condition)) {
          logger.debug(
            { nodeId: currentNode.id },
            'Decision node cannot be evaluated yet - waiting for required context values'
          )
          break
        }

        const conditionMet = this.stateManager.evaluateCondition(
          currentNode.condition
        )
        const nextNodeId = conditionMet
          ? currentNode.nextNodes[0]
          : currentNode.nextNodes[1]
        this.stateManager.setCurrentNode(nextNodeId)
        currentNode = this.sop.nodes[nextNodeId]
        continue
      }

      // For simple action nodes without tools, advance
      if (currentNode.type === 'action' && !currentNode.tool) {
        this.stateManager.setCurrentNode(currentNode.nextNodes[0])
        currentNode = this.sop.nodes[currentNode.nextNodes[0]]
        continue
      }

      // Otherwise stop - we've reached a node that needs LLM processing
      break
    }
  }

  /**
   * Process a user message using LLM-driven navigation
   */
  async processMessage(userMessage: string): Promise<string> {
    // Add user message to history
    this.stateManager.addMessage('user', userMessage)

    // Advance through simple action nodes (greeting, etc.) before building prompt
    this.advanceThroughSimpleNodes()

    // Execute tool at current node if required
    await this.executeNodeTool()

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
      logger.error({ error }, 'Error calling LLM')
      return 'I apologize, but I encountered an error processing your request. Please try again.'
    }

    let assistantMessage = ''

    // Process tool calls if any
    if (response.additional_kwargs?.tool_calls) {
      for (const toolCall of response.additional_kwargs.tool_calls) {
        const toolName = toolCall.function.name
        const toolArgs = JSON.parse(toolCall.function.arguments)

        try {
          let toolResult: any

          // Handle built-in updateContext tool
          if (toolName === 'updateContext') {
            const { key, value } = toolArgs
            this.stateManager.updateContext(key, value)
            toolResult = { success: true, key, value }
          } else {
            // Execute MCP tool
            toolResult = await this.executeTool(toolName, toolArgs)
            logger.debug({ tool: toolName, result: toolResult }, 'Tool result')

            // Update context with tool result based on tool name
            if (toolName === 'getUserDetails') {
              this.stateManager.updateContext('userDetails', toolResult)
            } else if (toolName === 'getOrderStatus') {
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

            // After MCP tool execution, advance through decision/action nodes if needed
            // This ensures we're at the right node before building the system prompt
            this.advanceAfterToolExecution()
          }

          // After tool execution, rebuild system prompt with updated context
          // This ensures messageTemplate placeholders are filled with tool results
          const updatedSystemPrompt = this.buildSystemPrompt()

          // Now call LLM again with tool result to get natural response
          const followUpMessages = [
            { role: 'system', content: updatedSystemPrompt },
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
            logger.debug(
              { toolName },
              'Empty response after tool execution - reconnecting flow'
            )
            assistantMessage = await this.reconnectFlow(
              userMessage,
              toolName,
              toolResult
            )
          }
        } catch (error) {
          logger.error({ tool: toolName, error }, 'Error executing tool')
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
      logger.debug('Empty response received - generating fallback response')
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

    // CRITICAL: If current node has a messageTemplate, use it!
    if (currentNode?.messageTemplate) {
      const filledTemplate = this.stateManager.replacePlaceholders(
        currentNode.messageTemplate
      )

      logger.debug(
        { nodeId: currentNode.id, template: filledTemplate },
        'Using messageTemplate in reconnectFlow'
      )

      return filledTemplate
    }

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
      logger.error({ error }, 'Error in reconnectFlow')
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
      logger.error({ error }, 'Error in generateFallbackResponse')
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
   * Note: Intent detection (e.g., customerWantsCancellation) is handled by the LLM
   * through tool calls, not through hard-coded pattern matching
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

    // Note: Customer intent detection is now handled by the LLM
    // The LLM should use tool calls or direct context updates based on the conversation
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
        // Check if we can evaluate the decision (all required values are set)
        if (!this.canEvaluateDecision(currentNode.condition)) {
          logger.debug(
            { nodeId: currentNode.id },
            'Decision node in updateCurrentNode cannot be evaluated yet'
          )
          break
        }

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
   * Check if a tool has been executed SUCCESSFULLY based on context
   * Returns false if the tool result contains an error
   */
  private hasToolBeenExecuted(
    toolName: string,
    context: Record<string, any>
  ): boolean {
    if (toolName === 'getUserDetails') {
      return !!context.userDetails && !context.userDetails.error
    } else if (toolName === 'getOrderStatus') {
      return !!context.orderStatus && !context.orderStatus.error
    } else if (toolName === 'cancelOrder') {
      return !!context.cancelResult && !context.cancelResult.error
    } else if (toolName === 'refundOrder') {
      return !!context.refundResult && !context.refundResult.error
    }
    return false
  }

  /**
   * Check if any context data referenced in a condition has errors
   */
  private hasErrorsInConditionContext(condition: string): boolean {
    const context = this.stateManager.getContext()

    // Extract context variable names from the condition
    // e.g., "context.orderStatus.minutesLate > 20" -> ["orderStatus"]
    const contextVarMatches = condition.match(/context\.([a-zA-Z0-9_]+)/g)

    if (!contextVarMatches) {
      return false
    }

    for (const match of contextVarMatches) {
      const varName = match.replace('context.', '')
      const value = context[varName]

      // Check if the value exists and has an error property
      if (value && typeof value === 'object' && value.error) {
        return true
      }
    }

    return false
  }

  /**
   * Check if decision condition can be evaluated (all required values are set)
   * Returns false if any value in the condition is null or undefined
   */
  private canEvaluateDecision(condition: string): boolean {
    const context = this.stateManager.getContext()

    // Extract all context paths from the condition
    // e.g., "context.customerWantsCancellation === true" -> ["customerWantsCancellation"]
    const contextPaths = condition.match(/context\.([a-zA-Z0-9_.]+)/g)

    if (!contextPaths) {
      return true // No context references, can evaluate
    }

    for (const match of contextPaths) {
      const path = match.replace('context.', '')
      const keys = path.split('.')
      let value: any = context

      // Navigate through the path to get the value
      for (const key of keys) {
        if (value && typeof value === 'object' && key in value) {
          value = value[key]
        } else {
          value = undefined
          break
        }
      }

      // If the value is null or undefined, we can't evaluate the decision yet
      if (value === null || value === undefined) {
        logger.debug(
          { path },
          'Decision condition cannot be evaluated - value is null/undefined'
        )
        return false
      }
    }

    return true
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
    this.stateManager = new ExecutionStateManager(
      this.sop.startNode,
      this.userId
    )
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
