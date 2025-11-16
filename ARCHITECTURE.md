# LLM-Driven SOP Engine Architecture

## Overview

This document describes the refactored architecture of the SOP Engine, which demonstrates how modern LLMs (Claude Sonnet 4.5) can execute complex workflows autonomously without traditional orchestration frameworks.

## Architectural Philosophy

**Key Principle**: The LLM is the workflow engine.

Instead of programmatically navigating through workflow nodes, we pass the complete SOP definition and execution state to the LLM on every interaction. The LLM then:

- Interprets the SOP structure
- Decides which tools to call
- Determines navigation paths
- Maintains natural conversation flow

## Architecture Comparison

### Traditional Approach (Code-Driven)

```
User Input → Navigator (Code) → Execute Tools → LLM (Response Only)
```

- Hard-coded decision logic
- Fixed navigation rules
- LLM only for text generation
- Requires complex orchestration frameworks

### LLM-Driven Approach (This POC)

```
User Input → LLM (Receives SOP + State) → Decides Tools & Navigation → Execute
```

- LLM interprets SOP structure
- Dynamic decision making
- No hardcoded workflow logic
- Simple agent architecture

## System Components

### 1. SOPAgent (Main Orchestrator)

**Responsibility**: Manages the conversation loop and coordinates between LLM and tools.

**Key Methods**:

- `processMessage(userMessage)`: Main entry point
- `buildSystemPrompt()`: Constructs context for LLM
- `executeTool(toolName, params)`: Executes MCP tools
- `extractContextFromMessages()`: Updates state from conversation
- `cleanResponse(rawResponse)`: Removes LLM thinking traces and metadata
- `advanceThroughSimpleNodes()`: Auto-navigates through simple action nodes
- `updateCurrentNode(assistantMessage)`: Manages workflow navigation
- `reconnectFlow()`: Handles empty responses after tool execution
- `generateFallbackResponse()`: Creates fallback when no response received
- `isTransitioningToEnd()`: Detects when approaching end nodes
- `removeHelpOffers()`: Removes "anything else" questions before ending

**Flow**:

```typescript
1. Receive user message
2. Advance through simple action nodes automatically
3. Build system prompt with:
   - Complete SOP JSON
   - Current execution state
   - Conversation history
   - Language support instructions
4. Send to LLM with available tools
5. Process LLM response:
   - Execute any tool calls
   - Update context with results
   - Generate follow-up response if needed
   - Handle empty responses with fallback mechanisms
6. Clean response (remove thinking traces, metadata)
7. Extract information from conversation
8. Update current node based on progress
9. Remove help offers if transitioning to end
10. Return natural language response
```

### 2. ExecutionStateManager

**Responsibility**: Tracks workflow state throughout the conversation.

**State Properties**:

```typescript
{
  currentNodeId: string;          // Current position in SOP
  visitedNodes: string[];         // Navigation history
  context: Record<string, any>;   // Extracted data
  conversationHistory: Message[]; // Full conversation
  status: 'in_progress' | 'completed' | 'error';
}
```

**Key Features**:

- Context value storage and retrieval
- Placeholder replacement in templates
- Condition evaluation
- Conversation history tracking

### 3. SOP Definition

**Structure**: JSON-based decision tree

```typescript
interface SOP {
  name: string
  description: string
  version: string
  startNode: string
  nodes: Record<string, SOPNode>
}

interface SOPNode {
  id: string
  type: 'action' | 'decision' | 'end'
  description: string
  tool?: string
  toolParams?: Record<string, string>
  messageTemplate?: string
  nextNodes?: string[]
  condition?: string
}
```

**Node Types**:

- **action**: Perform an action (call tool, send message)
- **decision**: Evaluate a condition and branch
- **end**: Terminal node, workflow complete

### 4. MCP Server

**Purpose**: Provides tools for the LLM to execute.

**Tools for Customer Support SOP**:

- `getOrderStatus(orderId)`: Retrieves order information
- `cancelOrder(orderId, reason)`: Cancels an order
- `refundOrder(orderId, amount)`: Processes refund

**Integration**: Uses Model Context Protocol standard for tool exposure.

## System Prompt Structure

On every user interaction, the LLM receives:

```
# YOUR ROLE
You are a customer support AI agent following an SOP.

# SOP DEFINITION
{Complete JSON structure of the SOP}

# CURRENT EXECUTION STATE
- Current Node: {nodeId}
- Node Type: {action|decision|end}
- Node Description: {description}
- Visited Nodes: [...]
- Status: {in_progress|completed|error}

# CURRENT CONTEXT
{All extracted data: orderId, orderStatus, etc.}

# CONVERSATION HISTORY
user: {message}
assistant: {response}
...

# INSTRUCTIONS
1. **Language Support**: 
   - ALWAYS respond in the same language the user is using
   - Detect user's language from their messages
   - Support ALL languages naturally

2. **Follow the SOP Flow**: You are at node "{currentNodeId}"
   - Based on node type and SOP definition, determine next action

3. **Node Types**:
   - action: Execute tool if specified, use messageTemplate
   - decision: Evaluate condition, choose next node
   - end: Complete the conversation

4. **Tool Execution**: When node specifies a tool, MUST call it

5. **Context Management**: 
   - Extract information from user messages
   - Store tool results for subsequent nodes
   - Replace placeholders in templates

6. **Navigation**:
   - After action node, determine next node from nextNodes
   - For decision nodes, evaluate condition and choose path
   - **CRITICAL**: Auto-transition to end nodes WITHOUT asking for more help

7. **End Node Handling**:
   - When next node is "end" type, DO NOT ask "anything else?"
   - Conclude conversation gracefully
   - Remove additional help prompts

8. **Natural Conversation**: Maintain helpful tone in user's language

9. **Response Format**: Address user naturally, call tools, extract context

# AVAILABLE TOOLS
- getOrderStatus: Retrieves order status
- cancelOrder: Cancels an order
- refundOrder: Processes refund
```

## Execution Flow

### Example: Late Order Cancellation

**User Message**: "Hi, where is my order #12345?"

**Step 1: Build Context**

```typescript
{
  currentNodeId: "start",
  context: {},
  conversationHistory: []
}
```

**Step 2: LLM Receives SOP**

```json
{
  "nodes": {
    "start": {
      "type": "action",
      "tool": "getOrderStatus",
      "nextNodes": ["check_delay"]
    },
    "check_delay": {
      "type": "decision",
      "condition": "context.minutesLate > 20"
    }
    // ... more nodes
  }
}
```

**Step 3: LLM Decides**

- "I'm at the start node"
- "This node requires calling getOrderStatus tool"
- "I need to extract orderId from user message: 12345"
- "Call getOrderStatus with orderId: 12345"

**Step 4: Tool Execution**

```typescript
executeTool('getOrderStatus', { orderId: '12345' })
// Returns: { orderId: '12345', minutesLate: 25, ... }
```

**Step 5: LLM Responds**

- Receives tool result
- Updates context: { orderId: '12345', minutesLate: 25 }
- Moves to next node: "check_delay"
- Evaluates condition: 25 > 20 = true
- Follows "late" path to "offer_cancellation"
- Generates natural response:
  "I see your order #12345 is running 25 minutes late. Would you like to cancel?"

**Step 6: Update State**

```typescript
{
  currentNodeId: "offer_cancellation",
  visitedNodes: ["start", "check_delay", "inform_delay", "offer_cancellation"],
  context: {
    orderId: "12345",
    minutesLate: 25,
    orderStatus: { /* full order data */ }
  }
}
```

## Key Benefits

### 1. No Hardcoded Logic

- All navigation decisions made by LLM
- No if/else chains for workflow logic
- Flexible adaptation to edge cases

### 2. Simplified Codebase

- Agent: ~600 lines (with robust error handling)
- State Manager: ~150 lines
- Navigator: ~150 lines
- No complex orchestration framework

### 3. Natural Conversation

- LLM understands context naturally
- Can handle variations in user input
- Generates human-like responses
- **Multi-language support** - responds in user's language
- **Clean responses** - removes internal thinking traces

### 4. Easy Extensibility

- Add new nodes to SOP JSON
- Add new tools to MCP server
- No code changes in agent logic

### 5. Transparent State

- Complete execution state visible
- Easy debugging with state inspection
- Clear audit trail

### 6. Robust Error Handling

- **Fallback mechanisms** for empty responses
- **Flow reconnection** after tool execution
- **Auto-navigation** through simple nodes
- **Graceful degradation** when errors occur

## Design Patterns

### 1. Context Accumulation

```typescript
// As conversation progresses, context grows
Initial: {}
After Q1: { orderId: "12345" }
After Tool: { orderId: "12345", orderStatus: {...} }
After Decision: { orderId: "12345", customerWantsCancellation: true }
```

### 2. Template Placeholders

```typescript
messageTemplate: 'Your order {context.orderId} is {context.status}'
// Becomes: "Your order 12345 is in_transit"
```

### 3. Condition Evaluation

```typescript
condition: 'context.minutesLate > 20'
// State manager evaluates based on current context
```

### 4. Tool Parameter Mapping

```typescript
toolParams: {
  orderId: "context.orderId",
  reason: "Late delivery"
}
// Resolves to: { orderId: "12345", reason: "Late delivery" }
```

### 5. Response Cleaning

```typescript
// LLM raw response may include internal reasoning
Raw: "**Thinking:** I should check the order. \n\nYour order is delayed."
// cleanResponse() removes metadata
Cleaned: "Your order is delayed."
```

### 6. Auto-Navigation

```typescript
// Automatically advance through simple nodes
start -> greeting (no tool) -> get_order (tool required) [STOP HERE]
// System advances to get_order before LLM interaction
```

### 7. Fallback Chain

```typescript
// If LLM response is empty:
1. Try reconnectFlow() - simpler prompt without tools
2. Try generateFallbackResponse() - use full system prompt
3. Use getToolBasedFallback() - hardcoded fallback by tool type
4. Final fallback: "I understand. How else can I assist you?"
```

### 8. End Node Detection

```typescript
// Prevent "anything else?" when ending
if (isTransitioningToEnd()) {
  response = removeHelpOffers(response)
}
// Ensures clean conversation closure
```

### 9. Intent Detection

```typescript
// Extract customer decisions from natural language
"Yes, please cancel" -> customerWantsCancellation: true
"No, I'll wait" -> customerWantsCancellation: false
// Uses pattern matching on user message
```

## Limitations & Considerations

### Current Implementation

1. **Condition Evaluation**: Uses Function constructor for safe evaluation (better than eval, but still limited)
2. **Node Navigation**: Heuristic-based with safety limits (max iterations to prevent infinite loops)
3. **Session Management**: Single conversation session (no multi-user support)
4. **Intent Detection**: Pattern-based extraction (works for simple cases, could be more sophisticated)
5. **Response Cleaning**: Regex-based removal of thinking traces (comprehensive but could miss edge cases)

### Production Considerations

1. **Enhanced Features**:
   - Session management for multi-user concurrent conversations
   - Proper expression evaluator for complex conditions
   - State persistence (database integration)
   - Rollback capabilities for error recovery
   - Comprehensive logging and monitoring
   - Metrics collection (response times, success rates)

2. **Robustness Improvements**:
   - More sophisticated intent detection (possibly using NLP)
   - Explicit node transition instructions from LLM
   - Timeout handling for long-running tool executions
   - Rate limiting and quota management

3. **Scalability**:
   - Caching layer for SOP definitions
   - Async processing for tool execution
   - Load balancing for MCP servers
   - Connection pooling for database and external services

4. **Security**:
   - Input validation and sanitization
   - Secure credential management for MCP tools
   - Audit logging for compliance
   - Rate limiting to prevent abuse

## Comparison with LangGraph

| Aspect              | LangGraph                         | This POC                      |
| ------------------- | --------------------------------- | ----------------------------- |
| Workflow Definition | Python code with graphs           | JSON decision tree            |
| Navigation Logic    | Framework-controlled              | LLM-controlled                |
| Complexity          | High (learning curve)             | Low (simple classes)          |
| Flexibility         | Limited by framework              | High (LLM interprets)         |
| Code Size           | 500+ lines typical                | ~900 lines total              |
| Dependencies        | Many (langchain, langgraph, etc.) | Minimal (langchain + MCP)     |
| Error Handling      | Manual implementation             | Built-in fallback mechanisms  |
| Multi-language      | Requires explicit setup           | Native LLM capability         |
| Response Quality    | Depends on prompts                | Auto-cleaned, user-focused    |
| Auto-navigation     | Manual state transitions          | Automatic through simple nodes|

## Recent Implementation Enhancements

The current implementation includes several production-ready features:

### 1. Multi-Language Support
- **Automatic Language Detection**: LLM detects user's language from messages
- **Consistent Language Use**: Maintains same language throughout conversation
- **No Configuration Required**: Works for all languages supported by the LLM
- **Implementation**: Embedded in system prompt instructions

### 2. Response Quality Control
- **Thinking Trace Removal**: Strips internal LLM reasoning from responses
- **Metadata Cleaning**: Removes workflow navigation comments
- **User-Focused Output**: Only shows relevant information to users
- **Pattern Matching**: Comprehensive regex patterns for various trace formats

### 3. Robust Error Handling
- **Empty Response Recovery**: Three-tier fallback mechanism
- **Flow Reconnection**: Dedicated handler for post-tool-execution issues
- **Context-Aware Fallbacks**: Uses current state to generate meaningful responses
- **Graceful Degradation**: Always provides a response, never fails silently

### 4. Intelligent Navigation
- **Auto-Advancement**: Automatically progresses through simple nodes
- **Safety Limits**: Prevents infinite loops with iteration caps
- **End Node Detection**: Identifies when approaching conversation end
- **Help Offer Removal**: Cleans up "anything else?" when concluding

### 5. Context Intelligence
- **Intent Detection**: Extracts customer decisions from natural language
- **Pattern Recognition**: Identifies affirmative/negative responses
- **Multi-Pattern Matching**: Handles various ways users express intent
- **State-Aware**: Considers current node when extracting context

### 6. Tool Integration
- **LangChain Binding**: Proper tool binding for Anthropic/Claude models
- **MCP Protocol**: Standard Model Context Protocol integration
- **Dynamic Tool Loading**: Discovers available tools at runtime
- **Result Context Mapping**: Automatically stores tool results in context

## Conclusion

This architecture proves that **modern LLMs can execute complex workflows autonomously** when provided with:

1. Clear SOP structure (JSON)
2. Current execution state
3. Available tools
4. Natural language instructions

No traditional workflow orchestration framework needed. The LLM IS the orchestrator.

**Key Achievements**:
- ✅ Fully autonomous workflow navigation
- ✅ Natural multi-language conversations
- ✅ Clean, user-focused responses
- ✅ Robust error handling with fallbacks
- ✅ Intelligent context extraction
- ✅ Graceful conversation endings

This opens new possibilities for:

- Simpler workflow automation
- More flexible business logic
- Easier maintenance and updates
- Natural conversation experiences
- Multi-language customer support without translation layers
- Self-healing conversations that recover from errors

The future of workflow automation may not need complex frameworks—just good prompts, capable LLMs, and thoughtful implementation of core patterns like response cleaning, auto-navigation, and fallback handling.
