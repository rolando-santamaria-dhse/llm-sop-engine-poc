/**
 * Logger configuration using Pino
 * Provides structured logging with pretty-printing for development
 */

import pino from 'pino'

// Determine if we're in development or production
const isDevelopment = process.env.NODE_ENV !== 'production'

// Create logger with appropriate configuration
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: isDevelopment
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname',
          messageFormat: '{levelLabel} - {msg}',
          errorLikeObjectKeys: ['err', 'error'],
        },
      }
    : undefined,
})

// Create child loggers for different modules
export const createLogger = (module: string) => {
  return logger.child({ module })
}
