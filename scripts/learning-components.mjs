// Shared build-time registry for focused descriptor/MDX checks (never client code).
import { remarkCodeWalkthrough } from '@vanhiep99w/docs-kit/code-walkthrough';
import { remarkCodeDiff } from '@vanhiep99w/docs-kit/code-diff';
import { remarkTerminalSession } from '@vanhiep99w/docs-kit/terminal-session';
import { remarkProtocolExchange } from '@vanhiep99w/docs-kit/protocol-exchange';
import { remarkSpanWaterfall } from '@vanhiep99w/docs-kit/span-waterfall';

export const learningPlugins = [remarkCodeWalkthrough, remarkCodeDiff, remarkTerminalSession, remarkProtocolExchange, remarkSpanWaterfall];
export const learningComponents = {
  'code-walkthrough': 'CodeWalkthrough',
  'code-diff': 'CodeDiff',
  'terminal-session': 'TerminalSession',
  'protocol-exchange': 'ProtocolExchange',
  'span-waterfall': 'SpanWaterfall',
};
