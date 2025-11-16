/**
 * SOP Engine - Proof of Concept
 *
 * Demonstrates Claude Sonnet 4.5's ability to execute workflows with tool calling
 * without complex orchestration frameworks like LangGraph.
 *
 * This implementation uses a simple agent that:
 * - Receives SOP as a unidirectional decision tree
 * - Tracks execution flow with node progress
 * - Uses MCP tools to effectively execute the SOP
 */

import dotenv from 'dotenv'
dotenv.config()

import { ChatOpenAI } from '@langchain/openai'
import * as readline from 'readline'
import { SOPAgent } from './engine/sop-agent'
import { OrderDelaySOP } from './sops/order-delay.sop'
import { OrderDelayExtendedSOP } from './sops/order-delay-extended.sop'
import * as path from 'path'
import { createLogger } from './utils/logger'

const logger = createLogger('Main')

async function main() {
  logger.info('='.repeat(80))
  logger.info('SOP Engine - LLM Proof of Concept')
  logger.info('='.repeat(80))
  logger.info(
    '\nThis demo showcases Claude Sonnet 4.5 executing a Standard Operating'
  )
  logger.info('Procedure (SOP) without complex workflow frameworks.\n')
  logger.info('Use Case: Delivery Hero Customer Support')
  logger.info('- Check order status')
  logger.info('- Cancel late orders (>20 minutes)')
  logger.info('- Process refunds')
  logger.info('='.repeat(80))

  // Initialize LLM (Claude Sonnet 4.5 via LiteLLM or direct Anthropic)
  const litellmProxyUrl = process.env.LITELLM_PROXY_URL
  const modelName = process.env.MODEL_NAME

  logger.info(`\n🤖 Initializing LLM: ${modelName}`)
  logger.info(`📡 LiteLLM Proxy: ${litellmProxyUrl}`)

  const llm = new ChatOpenAI({
    modelName: modelName,
    openAIApiKey: process.env.OPENAI_API_KEY,
    configuration: {
      baseURL: `${litellmProxyUrl}`,
    },
    temperature: 0.7,
  })

  // Initialize SOP Agent with demo userId
  logger.info(
    '\n📋 Loading SOP: Customer Support - Order Status & Cancellation'
  )
  const demoUserId = 'demo-user-' + Date.now()
  logger.info({ userId: demoUserId }, 'Demo User ID')
  const agent = new SOPAgent(OrderDelaySOP, llm, demoUserId)

  // Initialize MCP Server connection
  logger.info('🔧 Connecting to MCP Server...')
  try {
    const mcpServerPath = path.join(__dirname, 'mcp-server', 'index.js')
    await agent.initializeMCP('node', [mcpServerPath])
    logger.info('✅ MCP Server connected successfully')
  } catch (error) {
    logger.error({ error }, '❌ Failed to connect to MCP Server')
    logger.info('\nPlease ensure the MCP server is built:')
    logger.info('  npm run build')
    process.exit(1)
  }

  logger.info('\n' + '='.repeat(80))
  logger.info(
    '🎯 Agent Ready! You can now interact with the customer support agent.'
  )
  logger.info('='.repeat(80))
  logger.info('\nExample scenarios to try:')
  logger.info(
    '1. "Hi, where is my order #12345?" (Late order - will offer cancellation)'
  )
  logger.info('2. "Check status of order #67890" (On-time order)')
  logger.info('3. "What\'s the status of #11111?" (Preparing order)')
  logger.info('\nType "quit" or "exit" to end the conversation.\n')

  // Create readline interface for interactive conversation
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  const askQuestion = (query: string): Promise<string> => {
    return new Promise((resolve) => {
      rl.question(query, resolve)
    })
  }

  // Start conversation loop
  let conversing = true

  while (conversing && !agent.isComplete()) {
    try {
      const userInput = await askQuestion('\n👤 You: ')

      // Check for exit commands
      if (
        userInput.toLowerCase().trim() === 'quit' ||
        userInput.toLowerCase().trim() === 'exit'
      ) {
        logger.info('\n👋 Thank you for using the SOP Engine demo!')
        conversing = false
        break
      }

      // Skip empty inputs
      if (!userInput.trim()) {
        continue
      }

      // Process the message through the SOP agent
      logger.info('\n🤖 Agent: Processing...')
      const response = await agent.processMessage(userInput)
      logger.info(`🤖 Agent: ${response}`)

      // Check if conversation is complete
      if (agent.isComplete()) {
        logger.info('\n✅ Conversation completed!')
        logger.info('\n' + '='.repeat(80))
        logger.info('Execution Summary:')
        logger.info('='.repeat(80))

        const executionState = agent.getExecutionState()
        logger.info({ status: executionState.status }, '📊 Status')
        logger.info(
          { nodes: executionState.visitedNodes.join(' → ') },
          '🔄 Nodes Visited'
        )
        logger.info(
          { count: executionState.conversationHistory.length },
          '💬 Messages Exchanged'
        )

        if (Object.keys(executionState.context).length > 0) {
          logger.info('\n📝 Context Data:')
          logger.info(executionState.context)
        }

        conversing = false
      }
    } catch (error) {
      logger.error({ error }, '\n❌ Error')
      logger.info('The conversation will continue...\n')
    }
  }

  // Cleanup
  rl.close()
  await agent.close()

  logger.info('\n' + '='.repeat(80))
  logger.info('Demo Complete')
  logger.info('='.repeat(80))
  logger.info('\n💡 Key Takeaways:')
  logger.info('   ✓ LLM navigated the SOP decision tree autonomously')
  logger.info('   ✓ Tools were called appropriately based on SOP nodes')
  logger.info('   ✓ Execution state tracked progress accurately')
  logger.info('   ✓ Natural conversation flow maintained throughout')
  logger.info(
    '\n🎉 This demonstrates that modern LLMs can execute complex workflows'
  )
  logger.info('   without heavy orchestration frameworks!\n')
}

// Run if executed directly
if (require.main === module) {
  main().catch((error) => {
    logger.error({ error }, 'Fatal error')
    process.exit(1)
  })
}

export { main }
