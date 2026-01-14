import { type Config } from './config.js';
import { diag } from './logging.js';

export type NotificationEvent =
  | 'OPPORTUNITY_DETECTED'
  | 'CYCLE_CREATED'
  | 'TX_SUBMITTED'
  | 'TX_CONFIRMED'
  | 'BRIDGE_PROVE_READY'
  | 'BRIDGE_FINALIZE_READY'
  | 'CYCLE_COMPLETED'
  | 'CYCLE_FAILED'
  | 'STUCK_DETECTED'
  | 'ERROR';

interface NotificationPayload {
  event: NotificationEvent;
  timestamp: string;
  data: Record<string, unknown>;
}

let webhookUrl: string | undefined;

export function initNotifications(config: Config): void {
  webhookUrl = config.webhookUrl;
  if (webhookUrl) {
    diag.info('Notifications enabled', { webhookUrl: '***' });
  }
}

export async function notify(
  event: NotificationEvent,
  data: Record<string, unknown>
): Promise<void> {
  if (!webhookUrl) return;

  const payload: NotificationPayload = {
    event,
    timestamp: new Date().toISOString(),
    data,
  };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(formatForWebhook(payload)),
    });

    if (!response.ok) {
      diag.warn('Webhook failed', { status: response.status, event });
    }
  } catch (err) {
    diag.warn('Webhook error', { error: String(err), event });
  }
}

// Format payload for common webhook services (Slack/Discord compatible)
function formatForWebhook(payload: NotificationPayload): unknown {
  const emoji = getEventEmoji(payload.event);
  const color = getEventColor(payload.event);

  // Discord/Slack compatible format
  return {
    embeds: [
      {
        title: `${emoji} ${formatEventName(payload.event)}`,
        color: color,
        fields: Object.entries(payload.data).map(([key, value]) => ({
          name: key,
          value: String(value),
          inline: true,
        })),
        timestamp: payload.timestamp,
        footer: {
          text: 'keeper-arb',
        },
      },
    ],
    // Slack format fallback
    text: `${emoji} *${formatEventName(payload.event)}*\n${JSON.stringify(payload.data, null, 2)}`,
  };
}

function getEventEmoji(event: NotificationEvent): string {
  switch (event) {
    case 'OPPORTUNITY_DETECTED':
      return '🎯';
    case 'CYCLE_CREATED':
      return '🚀';
    case 'TX_SUBMITTED':
      return '📤';
    case 'TX_CONFIRMED':
      return '✅';
    case 'BRIDGE_PROVE_READY':
    case 'BRIDGE_FINALIZE_READY':
      return '🌉';
    case 'CYCLE_COMPLETED':
      return '💰';
    case 'CYCLE_FAILED':
      return '❌';
    case 'STUCK_DETECTED':
      return '⚠️';
    case 'ERROR':
      return '🚨';
    default:
      return '📝';
  }
}

function getEventColor(event: NotificationEvent): number {
  switch (event) {
    case 'CYCLE_COMPLETED':
      return 0x238636; // Green
    case 'CYCLE_FAILED':
    case 'ERROR':
      return 0xda3633; // Red
    case 'STUCK_DETECTED':
      return 0x9e6a03; // Yellow
    default:
      return 0x58a6ff; // Blue
  }
}

function formatEventName(event: NotificationEvent): string {
  return event
    .split('_')
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ');
}

// Convenience functions for common notifications
export function notifyOpportunity(token: string, discount: number, vcredIn: string): Promise<void> {
  return notify('OPPORTUNITY_DETECTED', { token, discount: `${discount}%`, vcredIn });
}

export function notifyCycleCreated(cycleId: number, token: string, vcredIn: string): Promise<void> {
  return notify('CYCLE_CREATED', { cycleId, token, vcredIn });
}

export function notifyTxSubmitted(cycleId: number, step: string, txHash: string): Promise<void> {
  return notify('TX_SUBMITTED', { cycleId, step, txHash });
}

export function notifyTxConfirmed(cycleId: number, step: string, txHash: string): Promise<void> {
  return notify('TX_CONFIRMED', { cycleId, step, txHash });
}

export function notifyCycleCompleted(
  cycleId: number,
  token: string,
  profit: string
): Promise<void> {
  return notify('CYCLE_COMPLETED', { cycleId, token, profit });
}

export function notifyCycleFailed(cycleId: number, token: string, error: string): Promise<void> {
  return notify('CYCLE_FAILED', { cycleId, token, error });
}

export function notifyStuck(cycleId: number, state: string, duration: string): Promise<void> {
  return notify('STUCK_DETECTED', { cycleId, state, duration });
}

export function notifyError(context: string, error: string): Promise<void> {
  return notify('ERROR', { context, error });
}
