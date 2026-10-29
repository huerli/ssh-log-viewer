import React, { createContext, useContext } from 'react';
import type { Profile } from './types';
export type TerminalSeed = { host: string; port: number; name: string; webMode: boolean; webAddress: string; webUser: string; webPassword: string; rememberPassword: boolean; device: string; deviceName: string; token: string };
export type SessionSeed = { kind: 'ssh'; profile: Profile } | { kind: 'telnet'; terminal: TerminalSeed } | { kind: 'log'; path: string };
export const SessionContext = createContext({ id: 'default', active: true, leftCollapsed: false, rightCollapsed: false, toggleLeft: () => {}, toggleRight: () => {}, tabBar: null as React.ReactNode, registerReconnect: (_callback: () => void): (() => void) => () => {}, beforeConnect: (_seed: SessionSeed): boolean => false, title: (_title: string) => {} });
export function useSession() { return useContext(SessionContext); }
export function useViewer() {
  const { id } = useSession();
  return React.useMemo(() => new Proxy({} as Window['viewer'], { get(_target, key: keyof Window['viewer']) {
    const target = window.viewer;
    if (key === 'getPathForFile') return target.getPathForFile;
    if (key === 'onEvent') return (callback: Parameters<typeof target.onEvent>[0]) => target.onEvent(event => { if (!event.sessionId || event.sessionId === id) callback(event); });
    return (...args: unknown[]) => target.sessionInvoke(id, String(key), args);
  } }), [id]);
}
export const slotId = (id: string, name: string) => `${id}-${name}`;

export function telnetEndpoint(terminal: TerminalSeed): string {
  if (terminal.webMode) {
    let address = terminal.webAddress.trim().replace(/\/+$/, '');
    try { address = new URL(address).href.replace(/\/+$/, ''); } catch {}
    return JSON.stringify(['web', address, terminal.device.trim()]);
  }
  return JSON.stringify(['direct', terminal.host.trim().replace(/^\[|\]$/g, '').toLowerCase(), Number(terminal.port)]);
}

export function sshEndpoint(profile: Profile): string {
  return JSON.stringify([profile.host.trim().toLowerCase(), Number(profile.port || 22), profile.username.trim(), profile.auth, profile.keyPath,
    profile.jump?.enabled ? [profile.jump.host.trim().toLowerCase(), Number(profile.jump.port || 22), profile.jump.username.trim(), profile.jumpName || ''] : null]);
}
