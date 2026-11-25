/**
 * Bot Team Host entry.
 *
 * A plain-JS bundle plugin: it injects the Host services it composes over and
 * owns one BotTeamService for its lifetime. Every registration (routes, event
 * listeners, agents, domain) is released through the service disposer.
 *
 * It also publishes the read-only `botTeamIdentity` service so a deployment
 * policy plugin can authorize per Bot/member instead of per shared workspace.
 */
import { BotTeamService } from './host/service.js';
import { createIdentityService, IDENTITY_SERVICE_NAME } from './host/identity.js';
import { resolveConfig } from './host/util.js';

// Package is published as dsh-bot-team; the Cordis plugin id stays bot-team,
// matching the built-in pattern (dsh-tool-bash → name "tool-bash").
export const name = 'bot-team';
export const inject = ['agents', 'storageDomain', 'connection', 'tools', 'agentPresets', 'sessionQuery', 'workspaceController'];

export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig && typeof rawConfig === 'object' ? rawConfig : {});
  const service = new BotTeamService(ctx, config);
  ctx.effect(() => () => service.dispose(), 'bot-team lifecycle');
  // Identity is read through the live service; repo/pool appear after `ready`.
  const identity = createIdentityService(ctx, () => service);
  ctx.effect(() => {
    const unprovide = ctx.provide(IDENTITY_SERVICE_NAME, identity);
    return () => { unprovide(); identity.dispose(); };
  }, 'bot-team identity');
}
