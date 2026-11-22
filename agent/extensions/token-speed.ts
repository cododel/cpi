import { FooterComponent, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

export default function (pi: ExtensionAPI) {
  let speed: string | undefined;
  let restore: (() => void) | undefined;

  // Pi 1.6 has no first-row slot. Decorate the stock renderer rather than
  // duplicating its counters or moving other extensions' status messages.
  pi.on('session_start', (_, ctx) => {
    if (ctx.mode !== 'tui') return;
    const original = FooterComponent.prototype.render;
    const render: typeof original = function (width) {
      const lines = original.call(this, width);
      if (!speed || !lines.length) return lines;
      const remaining = width - visibleWidth(speed);
      if (remaining < 3) return lines;
      const left = truncateToWidth(lines[0], remaining - 2, '…');
      lines[0] = left + ' '.repeat(remaining - visibleWidth(left)) + ctx.ui.theme.fg('dim', speed);
      return lines;
    };
    FooterComponent.prototype.render = render;
    restore = () => {
      if (FooterComponent.prototype.render === render) FooterComponent.prototype.render = original;
    };
  });
  pi.on('session_shutdown', () => { restore?.(); });
  let bytes = 0;
  let lastUpdate = 0;

  pi.on('message_start', ({ message }, ctx) => {
    if (!ctx.hasUI || message.role !== 'assistant') return;
    bytes = 0;
    lastUpdate = 0;
    speed = undefined;
  });

  pi.on('message_update', ({ message, assistantMessageEvent: event }, ctx) => {
    if (!ctx.hasUI || message.role !== 'assistant' || !('delta' in event) || typeof event.delta !== 'string') return;
    bytes += Buffer.byteLength(event.delta);
    const now = Date.now();
    const elapsed = now - message.timestamp;
    if (!bytes || elapsed < 250 || now - lastUpdate < 250) return;
    lastUpdate = now;
    // Rough fallback for streams that report usage only at completion.
    const tokens = message.usage.output || bytes / 4;
    speed = `≈${(tokens * 1000 / elapsed).toFixed(1)} tok/s`;
  });

  pi.on('message_end', ({ message }, ctx) => {
    if (!ctx.hasUI || message.role !== 'assistant') return;
    const ms = message.durationMs;
    const tokens = message.usage.output;
    speed = ms && ms > 0 && tokens > 0 ? `${(tokens * 1000 / ms).toFixed(1)} tok/s` : undefined;
  });
}
