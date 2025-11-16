/**
 * Extended Customer Support SOP for Delivery Hero
 *
 * This is an extended version of the Order Delay SOP with more comprehensive
 * customer support flows, including premium member checks, compensation options,
 * driver tracking, and escalation paths. Still uses the same 3 tools.
 */

import { SOP } from '../types/sop.types'

export const OrderDelayExtendedSOP: SOP = {
  name: 'Order Delay - Extended Support Flow',
  description:
    'Comprehensive order support including status checks, cancellations, compensation, and escalation paths',
  version: '2.0.0',
  startNode: 'greeting',

  nodes: {
    // Initial greeting and order ID collection
    greeting: {
      id: 'greeting',
      type: 'action',
      description: 'Greet the customer and ask for their order ID',
      messageTemplate:
        "Hello! I'm here to help you with your order. Could you please provide your order ID?",
      nextNodes: ['check_order_status'],
    },

    // Check the order status using the tool
    check_order_status: {
      id: 'check_order_status',
      type: 'action',
      description: "Retrieve the current status of the customer's order",
      tool: 'getOrderStatus',
      toolParams: {
        orderId: '{context.orderId}',
      },
      nextNodes: ['verify_customer_info'],
    },

    // Verify customer information
    verify_customer_info: {
      id: 'verify_customer_info',
      type: 'action',
      description:
        'Acknowledge order and ask customer to confirm their contact details',
      messageTemplate:
        "I've found your order #{context.orderStatus.orderId}. To assist you better, can you confirm your registered phone number or email?",
      nextNodes: ['evaluate_order_value'],
    },

    // Evaluate if this is a high-value order
    evaluate_order_value: {
      id: 'evaluate_order_value',
      type: 'decision',
      description: 'Check if order value exceeds $50 for priority handling',
      condition: 'context.orderStatus.totalAmount > 50',
      nextNodes: ['check_premium_status', 'evaluate_delay'],
    },

    // Check if customer is a premium member
    check_premium_status: {
      id: 'check_premium_status',
      type: 'decision',
      description: 'Determine if customer has premium membership',
      condition: 'context.isPremiumMember === true',
      nextNodes: ['premium_greeting', 'evaluate_delay'],
    },

    // Special greeting for premium members
    premium_greeting: {
      id: 'premium_greeting',
      type: 'action',
      description: 'Acknowledge premium status and offer enhanced support',
      messageTemplate:
        'Thank you for being a valued premium member! I will personally ensure your order receives priority attention.',
      nextNodes: ['evaluate_delay'],
    },

    // Evaluate if the order is delayed
    evaluate_delay: {
      id: 'evaluate_delay',
      type: 'decision',
      description: 'Check if the order is delayed by more than 20 minutes',
      condition: 'context.orderStatus.minutesLate > 20',
      nextNodes: ['assess_delay_severity', 'provide_status'],
    },

    // Assess how severe the delay is
    assess_delay_severity: {
      id: 'assess_delay_severity',
      type: 'decision',
      description:
        'Categorize delay severity for appropriate response (>45 min is critical)',
      condition: 'context.orderStatus.minutesLate > 45',
      nextNodes: ['critical_delay_response', 'moderate_delay_response'],
    },

    // Response for critical delays (>45 minutes)
    critical_delay_response: {
      id: 'critical_delay_response',
      type: 'action',
      description:
        'Apologize profusely for critical delay and offer immediate solutions',
      messageTemplate:
        'I sincerely apologize for this significant delay of {context.orderStatus.minutesLate} minutes. This is unacceptable. I want to make this right immediately. Would you like to: 1) Cancel with full refund, or 2) Keep the order and receive a compensation voucher?',
      nextNodes: ['customer_compensation_choice'],
    },

    // Response for moderate delays (20-45 minutes)
    moderate_delay_response: {
      id: 'moderate_delay_response',
      type: 'action',
      description:
        'Inform about moderate delay and provide tracking information',
      messageTemplate:
        'I see your order is running {context.orderStatus.minutesLate} minutes behind schedule. I apologize for this delay. Your order is currently {context.orderStatus.status}. Would you like to track the driver or discuss cancellation options?',
      nextNodes: ['customer_action_choice'],
    },

    // Customer chooses compensation type
    customer_compensation_choice: {
      id: 'customer_compensation_choice',
      type: 'decision',
      description: 'Handle customer choice for critical delay compensation',
      condition: 'context.customerWantsCancellation === true',
      nextNodes: ['cancel_order', 'offer_voucher_compensation'],
    },

    // Customer chooses action for moderate delay
    customer_action_choice: {
      id: 'customer_action_choice',
      type: 'decision',
      description: 'Route customer based on their preference',
      condition: 'context.customerWantsCancellation === true',
      nextNodes: ['cancel_order', 'provide_tracking_info'],
    },

    // Provide tracking information
    provide_tracking_info: {
      id: 'provide_tracking_info',
      type: 'action',
      description: 'Share driver location and updated ETA',
      messageTemplate:
        'Your driver is currently on their way. The updated estimated delivery time is {context.orderStatus.estimatedDeliveryTime}. You can track the driver in real-time through our app.',
      nextNodes: ['ask_satisfaction'],
    },

    // Offer voucher compensation
    offer_voucher_compensation: {
      id: 'offer_voucher_compensation',
      type: 'action',
      description: 'Provide compensation voucher for future orders',
      messageTemplate:
        "I've applied a $15 voucher to your account as compensation for this delay. Your order will continue and should arrive by {context.orderStatus.estimatedDeliveryTime}.",
      nextNodes: ['ask_satisfaction'],
    },

    // Path for on-time orders - just provide status
    provide_status: {
      id: 'provide_status',
      type: 'action',
      description: 'Provide order status and estimated delivery time',
      messageTemplate:
        'Your order #{context.orderStatus.orderId} is {context.orderStatus.status} and on schedule. The estimated delivery time is {context.orderStatus.estimatedDeliveryTime}.',
      nextNodes: ['ask_additional_help'],
    },

    // Cancel the order
    cancel_order: {
      id: 'cancel_order',
      type: 'action',
      description: 'Cancel the order',
      tool: 'cancelOrder',
      toolParams: {
        orderId: '{context.orderId}',
        reason: 'Customer requested cancellation due to delay',
      },
      nextNodes: ['determine_refund_type'],
    },

    // Determine refund type based on situation
    determine_refund_type: {
      id: 'determine_refund_type',
      type: 'decision',
      description: 'Check if premium member or high-value order for priority refund',
      condition:
        'context.isPremiumMember === true || context.orderStatus.totalAmount > 50',
      nextNodes: ['process_priority_refund', 'process_standard_refund'],
    },

    // Process priority refund (instant)
    process_priority_refund: {
      id: 'process_priority_refund',
      type: 'action',
      description: 'Process instant refund for premium/high-value orders',
      tool: 'refundOrder',
      toolParams: {
        orderId: '{context.orderId}',
        amount: '{context.orderStatus.totalAmount}',
      },
      nextNodes: ['confirm_priority_refund'],
    },

    // Process standard refund
    process_standard_refund: {
      id: 'process_standard_refund',
      type: 'action',
      description: 'Process standard refund',
      tool: 'refundOrder',
      toolParams: {
        orderId: '{context.orderId}',
        amount: '{context.orderStatus.totalAmount}',
      },
      nextNodes: ['confirm_standard_refund'],
    },

    // Confirm priority refund
    confirm_priority_refund: {
      id: 'confirm_priority_refund',
      type: 'action',
      description: 'Confirm instant refund to premium customer',
      messageTemplate:
        "I've processed an instant priority refund of ${context.refundResult.refundAmount} for order #{context.cancelResult.orderId}. As a valued customer, this refund will appear in your account immediately.",
      nextNodes: ['offer_discount_code'],
    },

    // Confirm standard refund
    confirm_standard_refund: {
      id: 'confirm_standard_refund',
      type: 'action',
      description: 'Confirm standard refund to customer',
      messageTemplate:
        "I've successfully processed a refund of ${context.refundResult.refundAmount} for order #{context.cancelResult.orderId}. The refund should appear in your account by {context.refundResult.estimatedRefundDate}.",
      nextNodes: ['ask_satisfaction'],
    },

    // Offer discount code for next order
    offer_discount_code: {
      id: 'offer_discount_code',
      type: 'action',
      description:
        'Provide additional discount code as goodwill gesture',
      messageTemplate:
        "As an apology for this experience, I've also added a 20% discount code to your account for your next order.",
      nextNodes: ['ask_satisfaction'],
    },

    // Ask if anything else needed
    ask_additional_help: {
      id: 'ask_additional_help',
      type: 'action',
      description: 'Check if customer needs any other assistance',
      messageTemplate: 'Is there anything else I can help you with regarding your order?',
      nextNodes: ['check_additional_request'],
    },

    // Check if customer has additional requests
    check_additional_request: {
      id: 'check_additional_request',
      type: 'decision',
      description: 'Route based on if customer has more questions',
      condition: 'context.hasAdditionalRequest === true',
      nextNodes: ['handle_additional_request', 'end_conversation'],
    },

    // Handle additional requests
    handle_additional_request: {
      id: 'handle_additional_request',
      type: 'action',
      description: 'Address any additional customer concerns',
      messageTemplate:
        'I understand. Let me help you with that additional request.',
      nextNodes: ['end_conversation'],
    },

    // Ask about customer satisfaction
    ask_satisfaction: {
      id: 'ask_satisfaction',
      type: 'action',
      description: 'Check if the resolution was satisfactory',
      messageTemplate:
        'I hope I was able to resolve your concern. Is there anything else I can assist you with today?',
      nextNodes: ['end_conversation'],
    },

    // End of conversation
    end_conversation: {
      id: 'end_conversation',
      type: 'end',
      description: 'Conversation completed',
      messageTemplate:
        'Thank you for contacting Delivery Hero. We appreciate your business and hope to serve you again soon!',
    },
  },
}
