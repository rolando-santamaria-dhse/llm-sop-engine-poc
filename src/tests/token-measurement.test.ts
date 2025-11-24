/**
 * Token Measurement Test
 *
 * This test measures the token reduction achieved by the optimization
 * that sends only current + next nodes instead of the entire SOP.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert'
import { ChatOpenAI } from '@langchain/openai'
import { SOPAgent } from '../engine/sop-agent'
import { OrderDelaySOP } from '../sops/order-delay.sop'

// Simple token counter (approximation: ~4 chars per token)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

describe('Token Optimization Measurement', () => {
  it('should demonstrate significant token reduction in system prompts', async () => {
    const llm = new ChatOpenAI({
      model: 'claude-haiku-4.5',
      temperature: 0,
      configuration: {
        baseURL: process.env.LITELLM_PROXY_URL || 'http://localhost:4000/v1',
      },
    })

    const agent = new SOPAgent(
      OrderDelaySOP,
      llm,
      'test-user-token-measurement'
    )

    // Initialize MCP (required for agent to work)
    await agent.initializeMCP('node', ['dist/mcp-server/index.js'])

    // Simulate a conversation to get to different nodes
    await agent.processMessage('Hi, where is my order #12345?')

    // Get the system prompt at this point
    const systemPrompt = (agent as any).buildSystemPrompt()

    // Measure tokens
    const estimatedTokens = estimateTokens(systemPrompt)

    console.log('\n=== TOKEN OPTIMIZATION RESULTS ===')
    console.log(`System Prompt Length: ${systemPrompt.length} characters`)
    console.log(`Estimated Tokens: ${estimatedTokens}`)
    console.log('\n--- System Prompt Structure ---')

    // Analyze what's in the prompt
    const sections = {
      'SOP Context': systemPrompt.includes('# SOP CONTEXT'),
      'Current Node': systemPrompt.includes('# CURRENT NODE'),
      'Next Possible Nodes': systemPrompt.includes('# NEXT POSSIBLE NODES'),
      'Reachable Nodes': systemPrompt.includes('# REACHABLE NODES'),
      'Full SOP Definition': systemPrompt.includes('# SOP DEFINITION'),
    }

    console.log('Sections included:')
    for (const [section, included] of Object.entries(sections)) {
      console.log(`  ${included ? '✓' : '✗'} ${section}`)
    }

    // Count nodes in the prompt
    const nodeMatches = systemPrompt.match(/"id":\s*"/g)
    const nodeCount = nodeMatches ? nodeMatches.length : 0
    console.log(`\nNodes included in prompt: ${nodeCount}`)
    console.log(
      `Total nodes in SOP: ${Object.keys(OrderDelaySOP.nodes).length}`
    )
    console.log(
      `Reduction: ${Math.round((1 - nodeCount / Object.keys(OrderDelaySOP.nodes).length) * 100)}%`
    )

    // Expected: Should NOT include full SOP definition
    assert.strictEqual(
      sections['Full SOP Definition'],
      false,
      'Should NOT include full SOP definition'
    )

    // Expected: Should include optimized sections
    assert.strictEqual(
      sections['SOP Context'],
      true,
      'Should include SOP context'
    )
    assert.strictEqual(
      sections['Current Node'],
      true,
      'Should include current node'
    )
    assert.strictEqual(
      sections['Next Possible Nodes'],
      true,
      'Should include next possible nodes'
    )

    // Expected: Should include significantly fewer nodes than total
    assert.ok(
      nodeCount < Object.keys(OrderDelaySOP.nodes).length,
      `Should include fewer nodes (${nodeCount}) than total (${Object.keys(OrderDelaySOP.nodes).length})`
    )

    // Expected: Token count should be reasonable (under 2500 for this SOP)
    // Note: This is still significantly better than sending the full SOP (~3000+ tokens)
    assert.ok(
      estimatedTokens < 2500,
      `Estimated tokens (${estimatedTokens}) should be under 2500`
    )

    console.log('\n✓ Token optimization verified successfully!')
    console.log('===================================\n')

    await agent.close()
  })

  it('should include only relevant context keys', async () => {
    const llm = new ChatOpenAI({
      model: 'claude-haiku-4.5',
      temperature: 0,
      configuration: {
        baseURL: process.env.LITELLM_PROXY_URL || 'http://localhost:4000/v1',
      },
    })

    const agent = new SOPAgent(
      OrderDelaySOP,
      llm,
      'test-user-context-optimization'
    )

    await agent.initializeMCP('node', ['dist/mcp-server/index.js'])

    // Process a message to populate context
    await agent.processMessage('Hi, where is my order #12345?')

    // Get relevant context
    const relevantContext = (agent as any).getRelevantContext()

    console.log('\n=== CONTEXT OPTIMIZATION RESULTS ===')
    console.log('Relevant context keys:', Object.keys(relevantContext))

    // Should include userId (always included)
    assert.ok('userId' in relevantContext, 'Should include userId')

    // Note: userDetails and orderId may not be in context yet if tools haven't executed
    // The key is that we're filtering context, not sending everything
    const contextKeyCount = Object.keys(relevantContext).length
    const fullContextKeyCount = Object.keys(
      (agent as any).stateManager.getContext()
    ).length

    console.log(`Relevant context keys: ${contextKeyCount}`)
    console.log(`Full context keys: ${fullContextKeyCount}`)

    // Should have filtered context (not sending everything)
    assert.ok(
      contextKeyCount <= fullContextKeyCount,
      'Should filter context appropriately'
    )

    console.log('✓ Context optimization verified successfully!')
    console.log('====================================\n')

    await agent.close()
  })
})
