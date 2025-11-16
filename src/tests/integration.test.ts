/**
 * Integration Tests for SOP Engine - LLM-Driven Determinism
 *
 * Tests the determinism of the Order Delay SOP execution with real LLM calls.
 * Validates that the LLM consistently navigates the SOP correctly based on inputs.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import { ChatOpenAI } from '@langchain/openai'
import { SOPAgent } from '../engine/sop-agent'
import { OrderDelaySOP } from '../sops/order-delay.sop'
import * as path from 'path'
import * as dotenv from 'dotenv'

// Load environment variables
dotenv.config()

describe('SOP Engine LLM Integration Tests', () => {
  let agent: SOPAgent
  let llm: ChatOpenAI

  before(async () => {
    // Initialize LLM with credentials from .env
    const litellmProxyUrl =
      process.env.LITELLM_PROXY_URL || 'http://localhost:4000'
    const modelName = process.env.MODEL_NAME || 'claude-sonnet-4.5'
    const apiKey = process.env.OPENAI_API_KEY || 'dummy-key'

    console.log(`\nInitializing LLM tests with model: ${modelName}`)
    console.log(`Using proxy: ${litellmProxyUrl}\n`)

    llm = new ChatOpenAI({
      modelName: modelName,
      openAIApiKey: apiKey,
      configuration: {
        baseURL: `${litellmProxyUrl}/v1`,
      },
      temperature: 0.1, // Low temperature for more deterministic responses
    })
  })

  describe('SOP Execution Determinism - Late Order Cancellation Path', () => {
    it('should consistently navigate to cancellation flow for late orders (English)', async () => {
      // Initialize agent
      agent = new SOPAgent(OrderDelaySOP, llm)

      // Connect to MCP server
      const mcpServerPath = path.join(__dirname, '..', 'mcp-server', 'index.js')
      await agent.initializeMCP('node', [mcpServerPath])

      // Scenario: Customer asks about late order
      const userMessage1 = 'Hi, where is my order #12345?'
      const response1 = await agent.processMessage(userMessage1)

      console.log(`\n[Test] User: ${userMessage1}`)
      console.log(`[Test] Agent: ${response1}`)

      // Verify agent acknowledged the request
      assert.ok(response1.length > 0, 'Agent should respond')
      assert.ok(!agent.isComplete(), 'Conversation should not be complete')

      // Check that order status was retrieved and stored
      const state1 = agent.getExecutionState()
      const orderStatus = state1.context.orderStatus

      assert.ok(orderStatus, 'Order status should be retrieved')
      assert.strictEqual(orderStatus.orderId, '12345', 'Order ID should match')

      // For order 12345, it should be late (>20 minutes)
      assert.ok(orderStatus.minutesLate > 20, 'Order should be late')

      console.log(`[Test] Order Status: ${JSON.stringify(orderStatus)}`)

      // Agent should offer cancellation for late order
      const lowerResponse = response1.toLowerCase()
      assert.ok(
        lowerResponse.includes('cancel') ||
          lowerResponse.includes('late') ||
          lowerResponse.includes('delay'),
        'Agent should mention cancellation or delay for late order'
      )

      // Customer confirms cancellation
      const userMessage2 = 'Yes, please cancel it'
      const response2 = await agent.processMessage(userMessage2)

      console.log(`\n[Test] User: ${userMessage2}`)
      console.log(`[Test] Agent: ${response2}`)

      // Verify cancellation was processed
      const state2 = agent.getExecutionState()
      assert.ok(
        state2.context.cancelResult || state2.context.refundResult,
        'Cancellation or refund should be processed'
      )

      // Conversation should eventually complete
      let attempts = 0
      while (!agent.isComplete() && attempts < 2) {
        const continueResponse = await agent.processMessage('Thank you')
        console.log(`\n[Test] User: Thank you`)
        console.log(`[Test] Agent: ${continueResponse}`)
        attempts++
      }

      const finalState = agent.getExecutionState()
      console.log(`\n[Test] Final Status: ${finalState.status}`)
      console.log(
        `[Test] Nodes Visited: ${finalState.visitedNodes.join(' → ')}`
      )

      // Verify expected nodes were visited for cancellation flow
      const visitedNodes = finalState.visitedNodes
      assert.ok(
        visitedNodes.some(
          (node) =>
            node.includes('check_order_status') || node.includes('status')
        ),
        'Should check order status'
      )

      await agent.close()
    })

    it('should consistently navigate to cancellation flow for late orders (Spanish)', async () => {
      // Initialize agent
      agent = new SOPAgent(OrderDelaySOP, llm)

      // Connect to MCP server
      const mcpServerPath = path.join(__dirname, '..', 'mcp-server', 'index.js')
      await agent.initializeMCP('node', [mcpServerPath])

      // Scenario: Customer asks in Spanish about late order
      const userMessage1 = 'Hola, ¿dónde está mi pedido #12345?'
      const response1 = await agent.processMessage(userMessage1)

      console.log(`\n[Test] User: ${userMessage1}`)
      console.log(`[Test] Agent: ${response1}`)

      // Verify agent responds in Spanish
      assert.ok(response1.length > 0, 'Agent should respond')

      // Check for Spanish keywords in response
      const hasSpanish = /[áéíóúñ¿]|pedido|orden|cancelar/i.test(response1)
      assert.ok(hasSpanish, 'Agent should respond in Spanish')

      // Order status should still be retrieved correctly
      const state1 = agent.getExecutionState()
      const orderStatus = state1.context.orderStatus

      assert.ok(orderStatus, 'Order status should be retrieved')
      assert.strictEqual(orderStatus.orderId, '12345', 'Order ID should match')
      assert.ok(orderStatus.minutesLate > 20, 'Order should be late')

      console.log(`[Test] Order Status: ${JSON.stringify(orderStatus)}`)

      // Customer confirms cancellation in Spanish
      const userMessage2 = 'Sí, por favor cancélalo'
      const response2 = await agent.processMessage(userMessage2)

      console.log(`\n[Test] User: ${userMessage2}`)
      console.log(`[Test] Agent: ${response2}`)

      // Verify cancellation was processed (same as English flow)
      const state2 = agent.getExecutionState()
      assert.ok(
        state2.context.cancelResult || state2.context.refundResult,
        'Cancellation or refund should be processed'
      )

      await agent.close()
    })
  })

  describe('SOP Execution Determinism - On-Time Order Path', () => {
    it('should consistently provide status for on-time orders and complete conversation', async () => {
      // Initialize agent
      agent = new SOPAgent(OrderDelaySOP, llm)

      // Connect to MCP server
      const mcpServerPath = path.join(__dirname, '..', 'mcp-server', 'index.js')
      await agent.initializeMCP('node', [mcpServerPath])

      // Scenario: Customer asks about on-time order
      const userMessage = "What's the status of order #67890?"
      const response = await agent.processMessage(userMessage)

      console.log(`\n[Test] User: ${userMessage}`)
      console.log(`[Test] Agent: ${response}`)

      // Verify agent responded
      assert.ok(response.length > 0, 'Agent should respond')

      // Check that order status was retrieved
      const state = agent.getExecutionState()
      const orderStatus = state.context.orderStatus

      assert.ok(orderStatus, 'Order status should be retrieved')
      assert.strictEqual(orderStatus.orderId, '67890', 'Order ID should match')

      // For order 67890, it should be on-time (<20 minutes late)
      assert.ok(orderStatus.minutesLate <= 20, 'Order should be on-time')

      console.log(`[Test] Order Status: ${JSON.stringify(orderStatus)}`)

      // Agent should NOT offer cancellation for on-time order
      const lowerResponse = response.toLowerCase()
      // Should provide status but not push for cancellation
      assert.ok(
        lowerResponse.includes('on') ||
          lowerResponse.includes('way') ||
          lowerResponse.includes('transit') ||
          lowerResponse.includes('delivering'),
        'Agent should provide positive status update'
      )

      // Verify the response does NOT contain help offers (should be filtered)
      assert.ok(
        !lowerResponse.includes('is there anything else i can help') &&
          !lowerResponse.includes('can i help you with anything else') &&
          !lowerResponse.includes('how else can i assist'),
        'Agent should NOT ask if they can help with anything else before end node'
      )

      const finalState = agent.getExecutionState()
      console.log(`\n[Test] Final Status: ${finalState.status}`)
      console.log(
        `[Test] Nodes Visited: ${finalState.visitedNodes.join(' → ')}`
      )

      // Verify conversation transitions to end node
      assert.ok(
        finalState.visitedNodes.includes('end_conversation') ||
          finalState.currentNodeId === 'end_conversation',
        'Should transition to end_conversation node'
      )

      await agent.close()
    })
  })

  describe('SOP Execution Determinism - Customer Declines Cancellation', () => {
    it('should handle customer declining cancellation for late order', async () => {
      // Initialize agent
      agent = new SOPAgent(OrderDelaySOP, llm)

      // Connect to MCP server
      const mcpServerPath = path.join(__dirname, '..', 'mcp-server', 'index.js')
      await agent.initializeMCP('node', [mcpServerPath])

      // Scenario: Customer asks about late order
      const userMessage1 = 'Hi, check order #12345 please'
      const response1 = await agent.processMessage(userMessage1)

      console.log(`\n[Test] User: ${userMessage1}`)
      console.log(`[Test] Agent: ${response1}`)

      // Verify order is late and cancellation is offered
      const state1 = agent.getExecutionState()
      const orderStatus = state1.context.orderStatus
      assert.ok(
        orderStatus && orderStatus.minutesLate > 20,
        'Order should be late'
      )

      // Customer declines cancellation
      const userMessage2 = "No, I'll wait for it"
      const response2 = await agent.processMessage(userMessage2)

      console.log(`\n[Test] User: ${userMessage2}`)
      console.log(`[Test] Agent: ${response2}`)

      // Verify NO cancellation was processed
      const state2 = agent.getExecutionState()

      console.log(
        `\n[Test] Context after decline:`,
        JSON.stringify(state2.context, null, 2)
      )
      console.log(`[Test] Cancel result:`, state2.context.cancelResult)
      console.log(
        `[Test] Customer wants cancellation:`,
        state2.context.customerWantsCancellation
      )

      assert.ok(
        !state2.context.cancelResult,
        'Order should NOT be cancelled when customer declines'
      )

      // Response should acknowledge customer's decision to wait
      const lowerResponse = response2.toLowerCase()
      console.log(`\n[Test] Response (lower): "${lowerResponse}"`)

      const hasAcknowledgement =
        lowerResponse.includes('understand') ||
        lowerResponse.includes('understood') ||
        lowerResponse.includes('wait') ||
        lowerResponse.includes('continue') ||
        lowerResponse.includes('keep') ||
        lowerResponse.includes('ok')

      console.log(`\n[Test] Has acknowledgement: ${hasAcknowledgement}`)

      assert.ok(
        hasAcknowledgement,
        "Agent should acknowledge customer's decision to wait"
      )

      console.log(`\n[Test] Final Status: ${state2.status}`)
      console.log(`[Test] Current Node: ${state2.currentNodeId}`)
      console.log(`[Test] Nodes Visited: ${state2.visitedNodes.join(' → ')}`)

      await agent.close()
    })
  })

  describe('SOP Execution Determinism - Tool Execution Consistency', () => {
    it('should consistently execute getOrderStatus tool', async () => {
      // Run the same scenario twice to verify determinism
      const results = []

      for (let i = 0; i < 2; i++) {
        agent = new SOPAgent(OrderDelaySOP, llm)
        const mcpServerPath = path.join(
          __dirname,
          '..',
          'mcp-server',
          'index.js'
        )
        await agent.initializeMCP('node', [mcpServerPath])

        const userMessage = 'Check my order #11111'
        await agent.processMessage(userMessage)

        const state = agent.getExecutionState()
        results.push({
          orderId: state.context.orderStatus?.orderId,
          status: state.context.orderStatus?.status,
          minutesLate: state.context.orderStatus?.minutesLate,
        })

        await agent.close()
      }

      console.log(`\n[Test] Run 1: ${JSON.stringify(results[0])}`)
      console.log(`[Test] Run 2: ${JSON.stringify(results[1])}`)

      // Verify both runs produced the same tool results
      assert.strictEqual(
        results[0].orderId,
        results[1].orderId,
        'Order ID should be consistent'
      )
      assert.strictEqual(
        results[0].status,
        results[1].status,
        'Status should be consistent'
      )
      assert.strictEqual(
        results[0].minutesLate,
        results[1].minutesLate,
        'Minutes late should be consistent'
      )
    })

    it('should execute tools in correct sequence for cancellation flow', async () => {
      agent = new SOPAgent(OrderDelaySOP, llm)
      const mcpServerPath = path.join(__dirname, '..', 'mcp-server', 'index.js')
      await agent.initializeMCP('node', [mcpServerPath])

      // Track tool executions
      const toolsExecuted: string[] = []

      // Override executeTool to track calls (simplified approach - just monitor context)
      const userMessage1 = 'Where is order #12345?'
      await agent.processMessage(userMessage1)

      const state1 = agent.getExecutionState()
      if (state1.context.orderStatus) {
        toolsExecuted.push('getOrderStatus')
      }

      const userMessage2 = 'Yes, cancel it please'
      await agent.processMessage(userMessage2)

      const state2 = agent.getExecutionState()
      if (state2.context.cancelResult) {
        toolsExecuted.push('cancelOrder')
      }
      if (state2.context.refundResult) {
        toolsExecuted.push('refundOrder')
      }

      console.log(`\n[Test] Tools executed: ${toolsExecuted.join(' → ')}`)

      // Verify correct sequence
      assert.ok(
        toolsExecuted.includes('getOrderStatus'),
        'Should execute getOrderStatus'
      )

      // Should execute either cancel or refund (or both)
      assert.ok(
        toolsExecuted.includes('cancelOrder') ||
          toolsExecuted.includes('refundOrder'),
        'Should execute cancellation/refund tools'
      )

      await agent.close()
    })
  })

  describe('SOP Execution Determinism - Context Preservation', () => {
    it('should maintain context across multiple interactions', async () => {
      agent = new SOPAgent(OrderDelaySOP, llm)
      const mcpServerPath = path.join(__dirname, '..', 'mcp-server', 'index.js')
      await agent.initializeMCP('node', [mcpServerPath])

      // First message
      await agent.processMessage('Check order #12345')
      const state1 = agent.getExecutionState()
      const orderId1 =
        state1.context.orderId || state1.context.orderStatus?.orderId

      // Second message (no order ID mentioned)
      await agent.processMessage('Yes, cancel it')
      const state2 = agent.getExecutionState()
      const orderId2 =
        state2.context.orderId || state2.context.orderStatus?.orderId

      console.log(`\n[Test] Order ID after first message: ${orderId1}`)
      console.log(`[Test] Order ID after second message: ${orderId2}`)

      // Verify context is preserved
      assert.strictEqual(
        orderId1,
        orderId2,
        'Order ID should be preserved across messages'
      )
      assert.strictEqual(
        orderId1,
        '12345',
        'Order ID should be extracted correctly'
      )

      await agent.close()
    })
  })
})
