#!/usr/bin/env node

/**
 * MCP Server for Order Management
 *
 * This server provides tools for managing customer orders:
 * - getOrderStatus: Retrieve order status and delivery information
 * - cancelOrder: Cancel a customer order
 * - refundOrder: Process a refund for a cancelled order
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js'

// Mock order database
interface Order {
  orderId: string
  status: 'preparing' | 'in_transit' | 'delivered' | 'cancelled'
  estimatedDeliveryTime: string
  actualDeliveryTime?: string
  orderPlacedTime: string
  minutesLate?: number
  totalAmount: number
  items: Array<{ name: string; quantity: number; price: number }>
  customerName: string
}

// In-memory order database
const orders: Map<string, Order> = new Map([
  [
    '12345',
    {
      orderId: '12345',
      status: 'in_transit',
      estimatedDeliveryTime: '2024-01-15T18:00:00Z',
      orderPlacedTime: '2024-01-15T17:00:00Z',
      minutesLate: 25,
      totalAmount: 42.5,
      items: [
        { name: 'Burger', quantity: 2, price: 12.0 },
        { name: 'Fries', quantity: 2, price: 5.0 },
        { name: 'Soda', quantity: 2, price: 4.25 },
      ],
      customerName: 'John Doe',
    },
  ],
  [
    '67890',
    {
      orderId: '67890',
      status: 'in_transit',
      estimatedDeliveryTime: '2024-01-15T18:30:00Z',
      orderPlacedTime: '2024-01-15T17:45:00Z',
      minutesLate: 5,
      totalAmount: 28.0,
      items: [
        { name: 'Pizza', quantity: 1, price: 18.0 },
        { name: 'Salad', quantity: 1, price: 10.0 },
      ],
      customerName: 'Jane Smith',
    },
  ],
  [
    '11111',
    {
      orderId: '11111',
      status: 'preparing',
      estimatedDeliveryTime: '2024-01-15T19:00:00Z',
      orderPlacedTime: '2024-01-15T18:00:00Z',
      minutesLate: 0,
      totalAmount: 35.75,
      items: [
        { name: 'Sushi Roll', quantity: 3, price: 11.0 },
        { name: 'Miso Soup', quantity: 1, price: 3.75 },
      ],
      customerName: 'Bob Wilson',
    },
  ],
  [
    '99999',
    {
      orderId: '99999',
      status: 'in_transit',
      estimatedDeliveryTime: '2024-01-15T17:30:00Z',
      orderPlacedTime: '2024-01-15T16:00:00Z',
      minutesLate: 50,
      totalAmount: 65.0,
      items: [
        { name: 'Steak', quantity: 2, price: 28.0 },
        { name: 'Wine', quantity: 1, price: 9.0 },
      ],
      customerName: 'Premium Customer',
    },
  ],
  [
    '88888',
    {
      orderId: '88888',
      status: 'in_transit',
      estimatedDeliveryTime: '2024-01-15T18:15:00Z',
      orderPlacedTime: '2024-01-15T17:30:00Z',
      minutesLate: 30,
      totalAmount: 38.5,
      items: [
        { name: 'Pasta', quantity: 2, price: 15.0 },
        { name: 'Garlic Bread', quantity: 2, price: 4.25 },
      ],
      customerName: 'Regular Customer',
    },
  ],
])

// Cancelled orders tracking
const cancelledOrders: Set<string> = new Set()

// Refund tracking
interface Refund {
  refundId: string
  orderId: string
  refundAmount: number
  estimatedRefundDate: string
  processedAt: string
}
const refunds: Map<string, Refund> = new Map()

// User database
interface User {
  userId: string
  name: string
  email: string
}

// In-memory user database
const users: Map<string, User> = new Map([
  [
    'test-user-001',
    {
      userId: 'test-user-001',
      name: 'John Smith',
      email: 'john.smith@example.com',
    },
  ],
  [
    'test-user-002',
    {
      userId: 'test-user-002',
      name: 'Jane Doe',
      email: 'jane.doe@example.com',
    },
  ],
  [
    'test-user-003',
    {
      userId: 'test-user-003',
      name: 'Bob Wilson',
      email: 'bob.wilson@example.com',
    },
  ],
  [
    'test-user-004',
    {
      userId: 'test-user-004',
      name: 'Alice Johnson',
      email: 'alice.johnson@example.com',
    },
  ],
  [
    'test-user-005',
    {
      userId: 'test-user-005',
      name: 'Charlie Brown',
      email: 'charlie.brown@example.com',
    },
  ],
])

// Define the tools
const tools: Tool[] = [
  {
    name: 'getUserDetails',
    description:
      'Retrieves user details including name, email, and JWT token for authentication',
    inputSchema: {
      type: 'object',
      properties: {
        userId: {
          type: 'string',
          description: 'The unique identifier for the user',
        },
      },
      required: ['userId'],
    },
  },
  {
    name: 'getOrderStatus',
    description:
      'Retrieves the current status of a customer order including delivery information and delay status',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: {
          type: 'string',
          description: 'The unique identifier for the order',
        },
        userId: {
          type: 'string',
          description: 'The unique identifier for the user making the request',
        },
      },
      required: ['orderId', 'userId'],
    },
  },
  {
    name: 'cancelOrder',
    description:
      'Cancels a customer order. Can only cancel orders that are not yet delivered.',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: {
          type: 'string',
          description: 'The unique identifier for the order',
        },
        reason: {
          type: 'string',
          description: 'Reason for cancellation',
        },
        userId: {
          type: 'string',
          description: 'The unique identifier for the user making the request',
        },
      },
      required: ['orderId', 'reason', 'userId'],
    },
  },
  {
    name: 'refundOrder',
    description: 'Processes a refund for a cancelled order',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: {
          type: 'string',
          description: 'The unique identifier for the order',
        },
        amount: {
          type: 'number',
          description: 'Refund amount in dollars',
        },
        userId: {
          type: 'string',
          description: 'The unique identifier for the user making the request',
        },
      },
      required: ['orderId', 'amount', 'userId'],
    },
  },
]

// Create the MCP server
const server = new Server(
  {
    name: 'order-management-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
)

// Handle list_tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools,
  }
})

// Handle call_tool request
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  try {
    if (name === 'getUserDetails') {
      const { userId } = args as { userId: string }

      // Log the userId for auditing purposes
      console.error(`[getUserDetails] Fetching details for user ${userId}`)

      const user = users.get(userId)
      if (!user) {
        // Generate a default user for demo/unknown users
        const defaultUser: User = {
          userId: userId,
          name: 'Guest User',
          email: `${userId}@example.com`,
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(defaultUser, null, 2),
            },
          ],
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(user, null, 2),
          },
        ],
      }
    }

    if (name === 'getOrderStatus') {
      const { orderId, userId } = args as { orderId: string; userId: string }

      // Log the userId for auditing purposes
      console.error(
        `[getOrderStatus] User ${userId} requesting status for order ${orderId}`
      )

      const order = orders.get(orderId)
      if (!order) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  error: 'Order not found',
                  orderId,
                },
                null,
                2
              ),
            },
          ],
        }
      }

      // Check if order was cancelled
      if (cancelledOrders.has(orderId)) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  ...order,
                  status: 'cancelled',
                },
                null,
                2
              ),
            },
          ],
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(order, null, 2),
          },
        ],
      }
    }

    if (name === 'cancelOrder') {
      const { orderId, reason, userId } = args as {
        orderId: string
        reason: string
        userId: string
      }

      // Log the userId for auditing purposes
      console.error(
        `[cancelOrder] User ${userId} cancelling order ${orderId} - Reason: ${reason}`
      )

      const order = orders.get(orderId)
      if (!order) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: false,
                  error: 'Order not found',
                  orderId,
                },
                null,
                2
              ),
            },
          ],
        }
      }

      // Check if already cancelled
      if (cancelledOrders.has(orderId)) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: false,
                  error: 'Order already cancelled',
                  orderId,
                },
                null,
                2
              ),
            },
          ],
        }
      }

      // Check if already delivered
      if (order.status === 'delivered') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: false,
                  error: 'Cannot cancel delivered order',
                  orderId,
                },
                null,
                2
              ),
            },
          ],
        }
      }

      // Cancel the order
      cancelledOrders.add(orderId)
      const cancelledAt = new Date().toISOString()

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                orderId,
                cancelledAt,
                reason,
                message: `Order ${orderId} has been successfully cancelled`,
              },
              null,
              2
            ),
          },
        ],
      }
    }

    if (name === 'refundOrder') {
      const { orderId, amount, userId } = args as {
        orderId: string
        amount: number
        userId: string
      }

      // Log the userId for auditing purposes
      console.error(
        `[refundOrder] User ${userId} processing refund of $${amount} for order ${orderId}`
      )

      const order = orders.get(orderId)
      if (!order) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: false,
                  error: 'Order not found',
                  orderId,
                },
                null,
                2
              ),
            },
          ],
        }
      }

      // Check if order is cancelled
      if (!cancelledOrders.has(orderId)) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: false,
                  error: 'Can only refund cancelled orders',
                  orderId,
                },
                null,
                2
              ),
            },
          ],
        }
      }

      // Check if already refunded
      if (refunds.has(orderId)) {
        const existingRefund = refunds.get(orderId)!
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: false,
                  error: 'Order already refunded',
                  existingRefund,
                },
                null,
                2
              ),
            },
          ],
        }
      }

      // Process refund
      const refundId = `REF-${Date.now()}`
      const estimatedRefundDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
        .toISOString()
        .split('T')[0] // 3 days from now
      const processedAt = new Date().toISOString()

      const refund: Refund = {
        refundId,
        orderId,
        refundAmount: amount,
        estimatedRefundDate,
        processedAt,
      }

      refunds.set(orderId, refund)

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                ...refund,
              },
              null,
              2
            ),
          },
        ],
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error: 'Unknown tool',
              tool: name,
            },
            null,
            2
          ),
        },
      ],
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error: 'Tool execution failed',
              details: error instanceof Error ? error.message : String(error),
            },
            null,
            2
          ),
        },
      ],
    }
  }
})

// Start the server
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('Order Management MCP Server running on stdio')
}

main().catch((error) => {
  console.error('Fatal error in main():', error)
  process.exit(1)
})
