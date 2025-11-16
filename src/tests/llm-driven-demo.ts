/**
 * LLM-Driven Architecture Demo
 *
 * This demonstrates the refactored architecture where the LLM receives
 * the complete SOP definition and execution state, and makes all decisions.
 */

import dotenv from 'dotenv'
dotenv.config()

import { ChatOpenAI } from '@langchain/openai'
import { SOPAgent } from '../engine/sop-agent'
import { OrderDelaySOP } from '../sops/order-delay.sop'
import * as path from 'path'

async function runLLMDrivenDemo() {
  console.log('='.repeat(70))
  console.log('SOP ENGINE - LLM-DRIVEN ARCHITECTURE DEMO')
  console.log('='.repeat(70))
  console.log(
    '\nThis demo shows how Claude Sonnet 4.5 navigates the SOP autonomously.'
  )
  console.log(
    'The LLM receives the complete SOP definition and execution state,'
  )
  console.log('and makes all navigation and tool-calling decisions.\n')

  // Initialize LLM
  const litellmProxyUrl =
    process.env.LITELLM_PROXY_URL || 'http://localhost:4000'
  const model = new ChatOpenAI({
    modelName: process.env.MODEL_NAME || 'claude-sonnet-4',
    openAIApiKey: process.env.OPENAI_API_KEY || 'dummy-key',
    configuration: {
      baseURL: `${litellmProxyUrl}/v1`,
    },
    temperature: 0.7,
  })

  // Initialize agent with SOP
  const agent = new SOPAgent(OrderDelaySOP, model)

  // Connect to MCP server
  const mcpServerPath = path.join(__dirname, '../../dist/mcp-server/index.js')
  console.log('Connecting to MCP server...')
  await agent.initializeMCP('node', [mcpServerPath])
  console.log('✓ MCP server connected\n')

  console.log('-'.repeat(70))
  console.log('SCENARIO: Customer with Late Order (Order #12345)')
  console.log('-'.repeat(70))

  try {
    // Simulate conversation
    const messages = [
      'Hi, where is my order #12345?',
      'Yes, please cancel it and refund me.',
    ]

    for (let i = 0; i < messages.length; i++) {
      const userMessage = messages[i]
      console.log(`\n👤 Customer: ${userMessage}`)

      // Get LLM-driven response
      const response = await agent.processMessage(userMessage)

      console.log(`🤖 Agent: ${response}`)

      // Show execution state
      const state = agent.getExecutionState()
      console.log(
        `\n📊 State: Node="${state.currentNodeId}", Status="${state.status}"`
      )

      if (agent.isComplete()) {
        console.log('\n✓ Conversation complete!')
        break
      }
    }
  } catch (error) {
    console.error('\n❌ Error during demo:', error)
  } finally {
    await agent.close()
  }

  console.log('\n' + '='.repeat(70))
  console.log('DEMO COMPLETE')
  console.log('='.repeat(70))
  console.log('\nKey Observations:')
  console.log('• The LLM received the SOP definition on each interaction')
  console.log('• The LLM decided when to call tools based on the SOP nodes')
  console.log('• The LLM navigated through the decision tree autonomously')
  console.log('• No hardcoded workflow logic - all decisions made by the LLM')
  console.log('\nThis proves modern LLMs can execute complex workflows')
  console.log('without traditional orchestration frameworks!\n')
}

// Run if executed directly
if (require.main === module) {
  runLLMDrivenDemo().catch(console.error)
}

export { runLLMDrivenDemo }
