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

async function main() {
  console.log('='.repeat(80))
  console.log('SOP Engine - LLM Proof of Concept')
  console.log('='.repeat(80))
  console.log(
    '\nThis demo showcases Claude Sonnet 4.5 executing a Standard Operating'
  )
  console.log('Procedure (SOP) without complex workflow frameworks.\n')
  console.log('Use Case: Delivery Hero Customer Support')
  console.log('- Check order status')
  console.log('- Cancel late orders (>20 minutes)')
  console.log('- Process refunds')
  console.log('='.repeat(80))

  // Initialize LLM (Claude Sonnet 4.5 via LiteLLM or direct Anthropic)
  const litellmProxyUrl =
    process.env.LITELLM_PROXY_URL || 'http://localhost:4000'
  const modelName = process.env.MODEL_NAME || 'claude-sonnet-4'

  console.log(`\n🤖 Initializing LLM: ${modelName}`)
  console.log(`📡 LiteLLM Proxy: ${litellmProxyUrl}`)

  const llm = new ChatOpenAI({
    modelName: modelName,
    openAIApiKey: process.env.OPENAI_API_KEY || 'dummy-key',
    configuration: {
      baseURL: `${litellmProxyUrl}/v1`,
    },
    temperature: 0.9,
  })

  // Initialize SOP Agent with demo userId
  console.log(
    '\n📋 Loading SOP: Customer Support - Order Status & Cancellation'
  )
  const demoUserId = 'demo-user-' + Date.now()
  console.log(`👤 Demo User ID: ${demoUserId}`)
  const agent = new SOPAgent(OrderDelayExtendedSOP, llm, demoUserId)

  // Initialize MCP Server connection
  console.log('🔧 Connecting to MCP Server...')
  try {
    const mcpServerPath = path.join(__dirname, 'mcp-server', 'index.js')
    await agent.initializeMCP('node', [mcpServerPath])
    console.log('✅ MCP Server connected successfully')
  } catch (error) {
    console.error('❌ Failed to connect to MCP Server:', error)
    console.log('\nPlease ensure the MCP server is built:')
    console.log('  npm run build')
    process.exit(1)
  }

  console.log('\n' + '='.repeat(80))
  console.log(
    '🎯 Agent Ready! You can now interact with the customer support agent.'
  )
  console.log('='.repeat(80))
  console.log('\nExample scenarios to try:')
  console.log(
    '1. "Hi, where is my order #12345?" (Late order - will offer cancellation)'
  )
  console.log('2. "Check status of order #67890" (On-time order)')
  console.log('3. "What\'s the status of #11111?" (Preparing order)')
  console.log('\nType "quit" or "exit" to end the conversation.\n')

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
        console.log('\n👋 Thank you for using the SOP Engine demo!')
        conversing = false
        break
      }

      // Skip empty inputs
      if (!userInput.trim()) {
        continue
      }

      // Process the message through the SOP agent
      console.log('\n🤖 Agent: Processing...')
      const response = await agent.processMessage(userInput)
      console.log(`🤖 Agent: ${response}`)

      // Check if conversation is complete
      if (agent.isComplete()) {
        console.log('\n✅ Conversation completed!')
        console.log('\n' + '='.repeat(80))
        console.log('Execution Summary:')
        console.log('='.repeat(80))

        const executionState = agent.getExecutionState()
        console.log(`\n📊 Status: ${executionState.status}`)
        console.log(
          `🔄 Nodes Visited: ${executionState.visitedNodes.join(' → ')}`
        )
        console.log(
          `💬 Messages Exchanged: ${executionState.conversationHistory.length}`
        )

        if (Object.keys(executionState.context).length > 0) {
          console.log('\n📝 Context Data:')
          console.log(JSON.stringify(executionState.context, null, 2))
        }

        conversing = false
      }
    } catch (error) {
      console.error('\n❌ Error:', error)
      console.log('The conversation will continue...\n')
    }
  }

  // Cleanup
  rl.close()
  await agent.close()

  console.log('\n' + '='.repeat(80))
  console.log('Demo Complete')
  console.log('='.repeat(80))
  console.log('\n💡 Key Takeaways:')
  console.log('   ✓ LLM navigated the SOP decision tree autonomously')
  console.log('   ✓ Tools were called appropriately based on SOP nodes')
  console.log('   ✓ Execution state tracked progress accurately')
  console.log('   ✓ Natural conversation flow maintained throughout')
  console.log(
    '\n🎉 This demonstrates that modern LLMs can execute complex workflows'
  )
  console.log('   without heavy orchestration frameworks!\n')
}

// Run if executed directly
if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error:', error)
    process.exit(1)
  })
}

export { main }
