/**
 * Customer Support SOP for Delivery Hero
 *
 * This SOP handles order status inquiries and allows customers to cancel
 * and refund orders that are late by more than 20 minutes.
 */

import { SOP } from '../types/sop.types'

export const OrderDelaySOP: SOP = {
  name: 'Order Delay - Order Status & Cancellation',
  description:
    'Handle customer inquiries about order status and process cancellations/refunds for late orders',
  version: '1.0.0',
  startNode: 'get_user_details',

  nodes: {
    // Fetch user details first
    get_user_details: {
      id: 'get_user_details',
      type: 'action',
      description: 'Retrieve user details to personalize the greeting',
      tool: 'getUserDetails',
      toolParams: {
        userId: '{context.userId}',
      },
      nextNodes: ['greeting'],
    },

    // Initial greeting and order ID collection
    greeting: {
      id: 'greeting',
      type: 'action',
      description: 'Greet the customer by name and ask for their order ID',
      messageTemplate:
        "Hello {context.userDetails.name}! I'm here to help you with your order. Could you please provide your order ID?",
      nextNodes: ['check_order_status'],
    },

    // Check the order status using the tool
    check_order_status: {
      id: 'check_order_status',
      type: 'action',
      description: "Retrieve the current status of the customer's order",
      tool: 'getOrderStatus',
      toolParams: {
        orderId: '{context.orderId}', // Will be replaced with actual order ID from context
      },
      nextNodes: ['evaluate_delay'],
    },

    // Evaluate if the order is delayed
    evaluate_delay: {
      id: 'evaluate_delay',
      type: 'decision',
      description: 'Check if the order is delayed by more than 20 minutes',
      condition: 'context.orderStatus.minutesLate > 20',
      nextNodes: ['offer_cancellation', 'provide_status'],
    },

    // Path 1: Order is late - offer cancellation
    offer_cancellation: {
      id: 'offer_cancellation',
      type: 'action',
      description:
        'Inform customer about delay and offer cancellation with refund',
      messageTemplate:
        'I see your order #{context.orderStatus.orderId} is currently {context.orderStatus.status} but is running {context.orderStatus.minutesLate} minutes behind schedule. I apologize for the delay. Would you like me to cancel this order and process a full refund?',
      nextNodes: ['customer_decision'],
    },

    // Path 2: Order is on time - just provide status
    provide_status: {
      id: 'provide_status',
      type: 'action',
      description: 'Provide order status and estimated delivery time',
      messageTemplate:
        'Your order #{context.orderStatus.orderId} is {context.orderStatus.status}. The estimated delivery time is {context.orderStatus.estimatedDeliveryTime}.',
      nextNodes: ['end_conversation'],
    },

    // Wait for customer's decision on cancellation
    customer_decision: {
      id: 'customer_decision',
      type: 'decision',
      description: 'Customer decides whether to cancel the order',
      condition: 'context.customerWantsCancellation === true',
      nextNodes: ['cancel_order', 'continue_with_order'],
    },

    // Customer wants to cancel
    cancel_order: {
      id: 'cancel_order',
      type: 'action',
      description: 'Cancel the order',
      tool: 'cancelOrder',
      toolParams: {
        orderId: '{context.orderId}',
        reason: 'Late delivery - customer requested cancellation',
      },
      nextNodes: ['process_refund'],
    },

    // Process refund after cancellation
    process_refund: {
      id: 'process_refund',
      type: 'action',
      description: 'Process refund for the cancelled order',
      tool: 'refundOrder',
      toolParams: {
        orderId: '{context.orderId}',
        amount: '{context.orderStatus.totalAmount}',
      },
      nextNodes: ['confirm_cancellation'],
    },

    // Confirm cancellation and refund
    confirm_cancellation: {
      id: 'confirm_cancellation',
      type: 'action',
      description: 'Confirm the cancellation and refund to the customer',
      messageTemplate:
        "I've successfully cancelled order #{context.cancelResult.orderId} and processed a full refund of ${context.refundResult.refundAmount}. The refund should appear in your account by {context.refundResult.estimatedRefundDate}.",
      nextNodes: ['end_conversation'],
    },

    // Customer decides to continue with the order
    continue_with_order: {
      id: 'continue_with_order',
      type: 'action',
      description: 'Customer decides to keep the order',
      messageTemplate:
        'Understood. Your order will continue as planned. The estimated delivery time is {context.orderStatus.estimatedDeliveryTime}.',
      nextNodes: ['end_conversation'],
    },

    // End of conversation
    end_conversation: {
      id: 'end_conversation',
      type: 'end',
      description: 'Conversation completed',
      messageTemplate: 'Thank you for contacting us. Have a great day!',
    },
  },
}
